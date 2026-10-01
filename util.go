package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"

	"github.com/pion/webrtc/v4"
)

var (
	errUnknownMessage  = errors.New("tipo de mensaje desconocido")
	errAlreadyUpstream = errors.New("ya estas conectado como emisor")
	errNoSuchUpstream  = errors.New("ese emisor no existe o todavia no tiene video")
	errSlowClient      = errors.New("el cliente no procesa los mensajes a tiempo")
)

// webrtcSDPAnswer envuelve un SDP de respuesta.
func webrtcSDPAnswer(sdp string) webrtc.SessionDescription {
	return webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	}
}

// webrtcGatheringPromise devuelve un canal que se cierra cuando Pion ha
// recolectado todos los candidatos ICE.
func webrtcGatheringPromise(pc *webrtc.PeerConnection) <-chan struct{} {
	return webrtc.GatheringCompletePromise(pc)
}

// newID genera un identificador corto y legible para logs.
func newID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "desconocido"
	}
	return hex.EncodeToString(b)
}
