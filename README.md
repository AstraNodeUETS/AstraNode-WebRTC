# AstraNode-WebRTC

Servidor SFU WebRTC para enviar vídeo desde un teléfono y verlo desde uno o
varios navegadores en la red local.

## Requisitos

- Go 1.27 o posterior.
- Un navegador con acceso a cámara y micrófono.
- Node.js 22 o posterior para ejecutar las pruebas de navegador.
- Un certificado TLS cuyo SAN incluya la IP con la que se conectarán los
	dispositivos.

## Preparación

Descarga las dependencias de Go:

```powershell
go mod download
```

Coloca el certificado y la clave privada en `certs/cert.pem` y
`certs/key.pem`. La clave privada y los certificados locales están excluidos
por `.gitignore`. Para desarrollo, genera un certificado autofirmado con una
herramienta como `mkcert` e incluye la IP de la red local en el certificado.

## Ejecución

```powershell
go run .
```

También se pueden cambiar la dirección y las rutas TLS:

```powershell
go run . -addr :8443 -cert certs/cert.pem -key certs/key.pem
```

Al iniciar, el servidor muestra las URLs disponibles para las interfaces:

- `/panel`: panel de control para ver las transmisiones.
- `/join`: emisor de vídeo desde el teléfono.
- `/view`: vista de espectador sin controles.
- `/ws`: endpoint WebSocket usado por la señalización.

Abre `/join` en el teléfono y `/panel` en el navegador que recibirá el vídeo.
Como el entorno usa HTTPS local, cada navegador debe confiar en el certificado
antes de permitir el acceso a la cámara.

## Pruebas de navegador

Con el servidor en ejecución, las pruebas abren Chrome con una cámara falsa y
comprueban que el vídeo llega al espectador:

```powershell
node tools/webrtc-probe.js https://192.168.0.101:8443
```

Para comprobar únicamente el estado del emisor:

```powershell
node tools/emitter-state.js https://192.168.0.101:8443
```

Si Chrome está instalado en otra ubicación, define `CHROME_PATH` antes de
ejecutar los probes.

## Validación del backend

```powershell
go test ./...
```
