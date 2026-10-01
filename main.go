// AstraNode-WebRTC - servidor de video P2P para redes locales.
//
// El servidor actua como punto de encuentro (SFU minimo): los celulares publican
// video hacia aqui y el servidor lo reenvia a los espectadores. Cada celular
// envia una sola copia del video sin importar cuantos espectadores haya.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

func main() {
	var (
		addr            = flag.String("addr", ":8443", "direccion de escucha")
		certFile        = flag.String("cert", "certs/cert.pem", "certificado TLS")
		keyFile         = flag.String("key", "certs/key.pem", "clave privada TLS")
		enableTunnel    = flag.Bool("tunnel", true, "iniciar un Quick Tunnel de Cloudflare")
		cloudflaredPath = flag.String("cloudflared", "", "ruta al ejecutable cloudflared")
	)
	flag.Parse()

	log.SetFlags(log.Ltime)

	cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		fatal("no se pudo cargar el certificado TLS (%s, %s): %v\n"+
			"    Ejecuta scripts/setup.ps1 para generarlo.", *certFile, *keyFile, err)
	}

	// Los celulares solo dan acceso a la camara en un contexto seguro (HTTPS) y
	// el certificado debe cubrir la IP de la red local. Verificamos esto al
	// arrancar para fallar con un mensaje claro en vez de con un error de camara
	// incomprensible en cada celular.
	if err := checkCertCoverage(*certFile); err != nil {
		log.Printf("AVISO: %v", err)
		log.Printf("       Regenera el certificado con scripts/setup.ps1")
	}

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		fatal("no se pudieron montar los archivos web: %v", err)
	}

	hub := newHub()
	assets := noCache(http.FileServer(http.FS(sub)))

	mux := http.NewServeMux()
	mux.Handle("/ws", hub)
	// URLs limpias. El FileServer solo resuelve /panel.html y no /panel, pero los
	// enlaces que se comparten con los celulares y con OBS se leen mucho mejor
	// sin la extension. El rewrite es interno: la barra de direcciones del
	// navegador se queda en /panel.
	mux.Handle("/panel", serveAs(assets, "panel.html"))
	mux.Handle("/join", serveAs(assets, "join.html"))
	mux.Handle("/view", serveAs(assets, "view.html"))
	mux.Handle("/", assets)

	srv := &http.Server{
		Addr:    *addr,
		Handler: mux,
		// Sin WriteTimeout: las conexiones WebSocket son de larga duracion y
		// un timeout de escritura las cortaria a mitad de transmision.
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}},
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		fatal("no se pudo escuchar en %s: %v", *addr, err)
	}

	var tunnel *exec.Cmd
	if *enableTunnel {
		port := listenPort(ln.Addr())
		var tunnelURL string
		tunnel, tunnelURL, err = startCloudflareTunnel(*cloudflaredPath, port)
		if err != nil {
			ln.Close()
			fatal("no se pudo iniciar el tunnel de Cloudflare: %v\n    Instala cloudflared o usa -tunnel=false para trabajar en local.", err)
		}
		defer stopTunnel(tunnel)
		printTunnelBanner(tunnelURL)
	} else {
		printLocalBanner(ln.Addr())
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	go func() {
		<-stop
		_ = srv.Shutdown(context.Background())
	}()

	if err := srv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal("el servidor termino con error: %v", err)
	}
}

func listenPort(addr net.Addr) string {
	_, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return "8443"
	}
	return port
}

func startCloudflareTunnel(configuredPath, port string) (*exec.Cmd, string, error) {
	executable, err := findCloudflared(configuredPath)
	if err != nil {
		return nil, "", err
	}

	cmd := exec.Command(executable, "tunnel", "--url", "https://localhost:"+port, "--no-tls-verify")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, "", err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, "", err
	}
	if err := cmd.Start(); err != nil {
		return nil, "", err
	}

	urlCh := make(chan string, 1)
	exitCh := make(chan error, 1)
	readTunnelOutput := func(reader io.Reader) {
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			if tunnelURL := extractTunnelURL(scanner.Text()); tunnelURL != "" {
				select {
				case urlCh <- tunnelURL:
				default:
				}
			}
		}
	}
	go readTunnelOutput(stdout)
	go readTunnelOutput(stderr)
	go func() { exitCh <- cmd.Wait() }()

	select {
	case tunnelURL := <-urlCh:
		return cmd, tunnelURL, nil
	case err := <-exitCh:
		if err == nil {
			err = errors.New("cloudflared termino antes de publicar la URL")
		}
		return nil, "", err
	case <-time.After(20 * time.Second):
		_ = cmd.Process.Kill()
		return nil, "", errors.New("timeout esperando la URL publica")
	}
}

func findCloudflared(configuredPath string) (string, error) {
	candidates := []string{}
	if configuredPath != "" {
		candidates = append(candidates, configuredPath)
	}
	if envPath := os.Getenv("CLOUDFLARED_PATH"); envPath != "" {
		candidates = append(candidates, envPath)
	}
	if path, err := exec.LookPath("cloudflared"); err == nil {
		candidates = append(candidates, path)
	}
	for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles")} {
		if base != "" {
			candidates = append(candidates, filepath.Join(base, "cloudflared", "cloudflared.exe"))
		}
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("no se encontro cloudflared; define CLOUDFLARED_PATH o instala cloudflared")
}

func extractTunnelURL(line string) string {
	for _, field := range strings.Fields(line) {
		field = strings.Trim(field, "|()[]")
		if strings.HasPrefix(field, "https://") && strings.HasSuffix(field, ".trycloudflare.com") {
			return field
		}
	}
	return ""
}

func stopTunnel(tunnel *exec.Cmd) {
	if tunnel != nil && tunnel.Process != nil {
		_ = tunnel.Process.Kill()
	}
}

// checkCertCoverage verifica que el certificado incluya todas las IPs de la red
// local. Es el fallo mas comun: la IP cambia por DHCP, el cert se queda viejo y
// cada celular muestra un aviso de seguridad que el usuario no sabe resolver.
func checkCertCoverage(certFile string) error {
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return fmt.Errorf("no se pudo leer el certificado: %w", err)
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return errors.New("el certificado no esta en formato PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return fmt.Errorf("el certificado no se pudo parsear: %w", err)
	}

	covered := make(map[string]bool, len(cert.IPAddresses))
	for _, ip := range cert.IPAddresses {
		covered[ip.String()] = true
	}

	var missing []string
	for _, ip := range localIPs() {
		if !covered[ip] {
			missing = append(missing, ip)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("el certificado NO cubre las IPs locales %s; "+
			"los celulares mostraran un aviso de seguridad", strings.Join(missing, ", "))
	}
	return nil
}

// localIPs devuelve las IPs IPv4 de la red local, ignorando loopback y las
// interfaces virtuales de Docker/WSL/Hyper-V que no sirven para conectar celulares.
func localIPs() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []string
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok || ipNet.IP.IsLoopback() {
			continue
		}
		ip4 := ipNet.IP.To4()
		if ip4 == nil {
			continue
		}
		// 169.254.0.0/16 es link-local: no sirve para nada practico.
		if ip4[0] == 169 && ip4[1] == 254 {
			continue
		}
		if isVirtual(ip4) {
			continue
		}
		out = append(out, ip4.String())
	}
	return out
}

// isVirtual descarta las IPs tipicas de adaptadores virtuales de Windows.
func isVirtual(ip net.IP) bool {
	ifaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if ok && ipNet.IP.Equal(ip) {
				name := strings.ToLower(iface.Name)
				for _, v := range []string{"vethernet", "docker", "wsl", "hyper-v", "loopback", "bluetooth"} {
					if strings.Contains(name, v) {
						return true
					}
				}
			}
		}
	}
	return false
}

func printLocalBanner(addr net.Addr) {
	_, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		port = "8443"
	}

	ips := localIPs()
	var shown []string
	if len(ips) == 0 {
		shown = append(shown, "localhost")
	} else {
		shown = ips
	}

	fmt.Println()
	fmt.Println("  AstraNode-WebRTC")
	fmt.Println("  ----------------")
	for _, ip := range shown {
		fmt.Printf("  Panel     https://%s/panel\n", net.JoinHostPort(ip, port))
		fmt.Printf("  Celular   https://%s/join\n", net.JoinHostPort(ip, port))
	}
	fmt.Println()
	fmt.Println("  Ctrl+C para detener")
	fmt.Println()
}

func printTunnelBanner(tunnelURL string) {
	fmt.Println()
	fmt.Println("  AstraNode-WebRTC")
	fmt.Println("  ----------------")
	fmt.Printf("  Panel     %s/panel\n", tunnelURL)
	fmt.Printf("  Celular   %s/join\n", tunnelURL)
	fmt.Println()
	fmt.Println("  Tunnel Cloudflare activo")
	fmt.Println("  Ctrl+C para detener")
	fmt.Println()
}

// serveAs sirve el archivo indicado bajo la URL actual, sin redirigir. Asi el
// usuario nunca ve /panel.html en la barra de direcciones.
func serveAs(next http.Handler, name string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + name
		next.ServeHTTP(w, r2)
	})
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Durante el desarrollo es comun dejar el navegador con una version vieja
		// del JS y no entender por que el cambio no surte efecto.
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		next.ServeHTTP(w, r)
	})
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "ERROR: "+format+"\n", args...)
	os.Exit(1)
}
