package main

import (
	"errors"
	"io"
	"log"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/intervalpli"
	"github.com/pion/webrtc/v4"
)

// errClosed marca el cierre de un upstream para que los bucles de RTP terminen.
var errClosed = errors.New("upstream cerrado")

// upstream es un emisor (celular) conectado a una sala.
//
// El telefono envia UNA sola copia de su video. upstream la reinyecta en un
// TrackLocalStaticRTP, al que se engancha cada espectador. Ese track es el que
// hace de "hub": escribir un paquete RTP en el lo reparte a todos los que lo
// consuman. Asi el celular no se calienta por tener que mandar N copias.
type upstream struct {
	peer *client

	pc  *webrtc.PeerConnection
	hub *webrtc.TrackLocalStaticRTP

	mu     sync.Mutex
	ready  bool
	closed bool
}

// newUpstream crea el PeerConnection que RECIBE video del celular.
//
// El servidor ofrece y el celular responde. Esto invierte el flujo normal de la
// mayoria de ejemplos de Pion, y es deliberado: el servidor necesita saber de
// antemano que pista esperar para poder enganchar el hub antes de que llegue el
// primer paquete.
func newUpstream(peer *client) (*upstream, error) {
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}

	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, err
	}

	// Pide un keyframe periodico mientras no llegue video. Sin esto, si un
	// espectador entra a mitad de stream se queda en negro hasta que el encoder
	// del celular decida generar el siguiente keyframe por su cuenta.
	pliFactory, err := intervalpli.NewReceiverInterceptor()
	if err != nil {
		return nil, err
	}
	registry.Add(pliFactory)

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
	)

	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{
			"stun:stun.cloudflare.com:3478",
			"stun:stun.l.google.com:19302",
		}}},
	})
	if err != nil {
		return nil, err
	}

	up := &upstream{peer: peer, pc: pc}

	// Declaramos que queremos recibir video. El codec exacto lo elige el
	// navegador al responder; no lo fijamos para no rechazar celulares.
	if _, err := pc.AddTransceiverFromKind(
		webrtc.RTPCodecTypeVideo,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly},
	); err != nil {
		pc.Close()
		return nil, err
	}

	pc.OnTrack(up.onTrack)

	return up, nil
}

// onTrack corre cuando el celular empieza a enviar video de verdad.
func (u *upstream) onTrack(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
	hub, err := webrtc.NewTrackLocalStaticRTP(
		remote.Codec().RTPCodecCapability,
		remote.ID(),
		remote.StreamID(),
	)
	if err != nil {
		log.Printf("[%s] no se pudo crear el track hub: %v", u.peer.label(), err)
		return
	}

	u.mu.Lock()
	if u.closed {
		u.mu.Unlock()
		return
	}
	u.hub = hub
	u.ready = true
	u.mu.Unlock()

	log.Printf("[%s] video recibido, listo para repartir", u.peer.label())
	u.peer.room.broadcastExcept(&msg{Type: msgUpstreamReady, Peer: u.peer.info()}, u.peer)

	u.pump(remote, hub)
}

// pump es el corazon del reparto: lee cada paquete RTP del celular y lo escribe
// en el track hub, de donde sale hacia todos los espectadores a la vez.
func (u *upstream) pump(remote *webrtc.TrackRemote, hub *webrtc.TrackLocalStaticRTP) {
	defer u.close()

	// 1500 bytes cabe en un datagrama IP normal; es el valor que recomienda la
	// propia documentacion de Pion.
	buf := make([]byte, 1500)
	for {
		n, _, err := remote.Read(buf)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, errClosed) {
				log.Printf("[%s] se termino de leer el video: %v", u.peer.label(), err)
			}
			return
		}
		// Escribir en un track sin suscriptores devuelve error y no es fatal:
		// simplemente todavia no hay a quien mandarle el video.
		_, _ = hub.Write(buf[:n])
	}
}

// hubTrack expone el track para que un espectador se enganche a el.
func (u *upstream) hubTrack() (*webrtc.TrackLocalStaticRTP, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed || u.hub == nil {
		return nil, false
	}
	return u.hub, true
}

func (u *upstream) close() {
	u.mu.Lock()
	if u.closed {
		u.mu.Unlock()
		return
	}
	u.closed = true
	u.mu.Unlock()

	u.pc.Close()
}

// downstream es un espectador (el panel, o el Browser Source de OBS) que quiere
// recibir el video de un upstream concreto.
type downstream struct {
	pc     *webrtc.PeerConnection
	sender *webrtc.RTPSender
}

// newDownstream crea un PeerConnection que ENVIA video al espectador, tomandolo
// del track hub del upstream.
func newDownstream(up *upstream, peer *client) (*downstream, error) {
	hub, ok := up.hubTrack()
	if !ok {
		return nil, errors.New("el emisor todavia no tiene video")
	}

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{
			"stun:stun.cloudflare.com:3478",
			"stun:stun.l.google.com:19302",
		}}},
	})
	if err != nil {
		return nil, err
	}

	sender, err := pc.AddTrack(hub)
	if err != nil {
		pc.Close()
		return nil, err
	}

	// AddTrack nos da el sender, y hay que leer sus RTCP (PLI, NACK, Reports).
	// Si nadie los lee, el control de congestion se atasca: el video se congela
	// sin mostrar ningun error. Es el fallo mas confuso de Pion.
	go drainRTCP(sender)

	return &downstream{pc: pc, sender: sender}, nil
}

// drainRTCP consume los paquetes de control de flujo del sender.
func drainRTCP(sender *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := sender.Read(buf); err != nil {
			return
		}
	}
}

// negotiate completa la negociacion de un downstream: el servidor envia una
// oferta al espectador y espera su respuesta.
func (d *downstream) negotiate(peer *client, upstreamID string) error {
	offer, err := d.pc.CreateOffer(nil)
	if err != nil {
		return err
	}

	// Recolectar los candidatos ICE antes de enviar la oferta evita el
	// "trickle ICE" y hace que un solo mensaje baste para negociar. Es mucho mas
	// simple de depurar que perseguir candidatos sueltos.
	gathered := webrtc.GatheringCompletePromise(d.pc)
	if err := d.pc.SetLocalDescription(offer); err != nil {
		return err
	}
	<-gathered

	return peer.send(&msg{
		Type: msgOffer,
		SDP:  d.pc.LocalDescription().SDP,
		ID:   upstreamID,
	})
}

// acceptAnswer aplica la respuesta del espectador a la oferta enviada.
func (d *downstream) acceptAnswer(sdp string) error {
	return d.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	})
}

func (d *downstream) close() {
	d.pc.Close()
}
