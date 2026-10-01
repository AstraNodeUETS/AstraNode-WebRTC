package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Tipos de mensaje del cliente al servidor.
	msgJoin      = "join"
	msgAnswer    = "answer"
	msgSubscribe = "subscribe"
	msgBye       = "bye"

	// Tipos de mensaje del servidor al cliente.
	msgWelcome       = "welcome"
	msgPeers         = "peers"
	msgOffer         = "offer"
	msgUpstreamReady = "upstream-ready"
	msgPeerLeft      = "peer-left"
	msgError         = "error"
)

const (
	writeWait    = 10 * time.Second
	pongWait     = 60 * time.Second
	pingPeriod   = (pongWait * 9) / 10
	maxMessageSz = 8192
)

// peerInfo es lo que un cliente ve de otro cliente.
type peerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// msg es el sobre unico de la senalizacion. Un solo tipo de struct mantiene el
// protocolo legible y evita tener que sincronizar varios JSON distintos.
type msg struct {
	Type  string     `json:"type"`
	Role  string     `json:"role,omitempty"`
	Name  string     `json:"name,omitempty"`
	SDP   string     `json:"sdp,omitempty"`
	ID    string     `json:"id,omitempty"`   // id al que se refiere este mensaje
	Peer  *peerInfo  `json:"peer,omitempty"` // emisor al que se refiere
	Peers []peerInfo `json:"peers,omitempty"`
	Error string     `json:"error,omitempty"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Solo nos sirve en la red local del operador; no exponemos esto a Internet
	// por ahora, asi que no hace falta filtrar por Origin.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// hub lleva el registro de salas. Solo hay una sala ("default"), pero separarla
// ahora evita reescribir todo el nucleo si mas adelante hacen falta varias.
type hub struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func newHub() *hub {
	return &hub{rooms: map[string]*room{"default": newRoom("default")}}
}

// room es una sala de emision. Los upstreams publican video, los downstreams lo
// miran.
type room struct {
	name string

	mu        sync.Mutex
	upstreams map[string]*upstream
	clients   map[string]*client
}

// client es una conexion WebSocket: un celular (upstream) o un espectador.
type client struct {
	id   string
	name string
	ws   *websocket.Conn
	room *room

	sendCh chan []byte

	mu   sync.Mutex
	up   *upstream
	down map[string]*downstream // por id de upstream
	done chan struct{}
}

func newRoom(name string) *room {
	return &room{
		name:      name,
		upstreams: map[string]*upstream{},
		clients:   map[string]*client{},
	}
}

func (h *hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("no se pudo abrir el websocket: %v", err)
		return
	}
	c := &client{
		id:     newID(),
		ws:     ws,
		room:   h.rooms["default"],
		sendCh: make(chan []byte, 16),
		down:   map[string]*downstream{},
		done:   make(chan struct{}),
	}

	go c.writePump()
	c.readPump()
}

func (r *room) addClient(c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[c.id] = c
}

func (r *room) removeClient(c *client) {
	r.mu.Lock()
	delete(r.clients, c.id)
	if c.up != nil {
		delete(r.upstreams, c.id)
	}
	r.mu.Unlock()
	// Si el emisor se va, todos los espectadores que lo estaban viendo deben
	// dejar de intentarlo.
	if c.up != nil {
		r.broadcastExcept(&msg{Type: msgPeerLeft, ID: c.id}, c)
	}
}

// upstreamsList devuelve los emisores que ya tienen video listo para repartir.
func (r *room) upstreamsList() []peerInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]peerInfo, 0, len(r.upstreams))
	for id, up := range r.upstreams {
		if _, ok := up.hubTrack(); !ok {
			continue // aun no tiene video
		}
		out = append(out, peerInfo{ID: id, Name: up.peer.name, Role: "upstream"})
	}
	return out
}

func (r *room) broadcast(m *msg) {
	r.broadcastExcept(m, nil)
}

func (r *room) broadcastExcept(m *msg, except *client) {
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	r.mu.Lock()
	targets := make([]*client, 0, len(r.clients))
	for _, c := range r.clients {
		if c != except {
			targets = append(targets, c)
		}
	}
	r.mu.Unlock()

	for _, c := range targets {
		c.trySend(data)
	}
}

func (c *client) info() *peerInfo {
	return &peerInfo{ID: c.id, Name: c.name, Role: c.role()}
}

func (c *client) role() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.up != nil {
		return "upstream"
	}
	return "downstream"
}

func (c *client) label() string {
	if c.name != "" {
		return c.name + " (" + c.id + ")"
	}
	return c.id
}

// send encola un mensaje. Si el buffer esta lleno, el cliente esta demasiado
// lento; lo desconectamos en vez de acumular memoria sin limite.
func (c *client) send(m *msg) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	select {
	case c.sendCh <- data:
		return nil
	case <-c.done:
		return nil
	default:
		return errSlowClient
	}
}

func (c *client) trySend(data []byte) {
	select {
	case c.sendCh <- data:
	case <-c.done:
	default:
		log.Printf("[%s] buffer lleno, se descarta el mensaje", c.label())
	}
}

func (c *client) readPump() {
	defer c.close()

	c.ws.SetReadLimit(maxMessageSz)
	c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error {
		c.ws.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("[%s] se corto la conexion: %v", c.label(), err)
			}
			return
		}

		var m msg
		if err := json.Unmarshal(data, &m); err != nil {
			log.Printf("[%s] mensaje invalido: %v", c.label(), err)
			c.send(&msg{Type: msgError, Error: "mensaje invalido"})
			continue
		}

		if err := c.handle(&m); err != nil {
			log.Printf("[%s] error: %v", c.label(), err)
			c.send(&msg{Type: msgError, Error: err.Error()})
		}
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.ws.Close()
	}()

	for {
		select {
		case data, ok := <-c.sendCh:
			c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.ws.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.ws.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *client) close() {
	select {
	case <-c.done:
		return // ya cerrada
	default:
	}

	c.mu.Lock()
	if c.up != nil {
		c.up.close()
	}
	downs := make([]*downstream, 0, len(c.down))
	for _, d := range c.down {
		downs = append(downs, d)
	}
	c.down = map[string]*downstream{}
	c.mu.Unlock()

	for _, d := range downs {
		d.close()
	}

	c.room.removeClient(c)
	close(c.done)
	c.ws.Close()
	log.Printf("[%s] desconectado", c.label())
}

// handle despacha un mensaje entrante.
func (c *client) handle(m *msg) error {
	switch m.Type {
	case msgJoin:
		return c.handleJoin(m)
	case msgAnswer:
		return c.handleAnswer(m)
	case msgSubscribe:
		return c.handleSubscribe(m)
	case msgBye:
		return nil
	default:
		return errUnknownMessage
	}
}

func (c *client) handleJoin(m *msg) error {
	c.name = m.Name
	if c.name == "" {
		c.name = "anonimo"
	}

	if m.Role == "upstream" {
		up, err := newUpstream(c)
		if err != nil {
			return err
		}
		c.mu.Lock()
		c.up = up
		c.mu.Unlock()

		c.room.addClient(c)
		c.room.mu.Lock()
		c.room.upstreams[c.id] = up
		c.room.mu.Unlock()

		// El servidor ofrece: "mandame video". El celular contesta con un
		// answer y a partir de ahi empiezan a correr los paquetes RTP.
		offer, err := up.pc.CreateOffer(nil)
		if err != nil {
			return err
		}
		gathered := webrtcGatheringPromise(up.pc)
		if err := up.pc.SetLocalDescription(offer); err != nil {
			return err
		}
		<-gathered

		if err := c.send(&msg{Type: msgOffer, SDP: up.pc.LocalDescription().SDP}); err != nil {
			return err
		}
		log.Printf("[%s] conectado como emisor", c.label())
		return nil
	}

	// Espectador: le damos la lista de emisores que ya tienen video.
	c.room.addClient(c)
	if err := c.send(&msg{Type: msgWelcome, ID: c.id}); err != nil {
		return err
	}
	if err := c.send(&msg{Type: msgPeers, Peers: c.room.upstreamsList()}); err != nil {
		return err
	}
	log.Printf("[%s] conectado como espectador", c.label())
	return nil
}

// handleAnswer aplica la respuesta del cliente a una oferta que le enviamos.
func (c *client) handleAnswer(m *msg) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Respuesta del celular a nuestra oferta de "mandame video".
	if c.up != nil {
		return c.up.pc.SetRemoteDescription(webrtcSDPAnswer(m.SDP))
	}

	// Respuesta de un espectador a la oferta de recibir video. El mensaje lleva
	// en ID a que emisor se refiere.
	d, ok := c.down[m.ID]
	if !ok {
		return errNoSuchUpstream
	}
	return d.acceptAnswer(m.SDP)
}

// handleSubscribe conecta a este espectador con un emisor concreto.
func (c *client) handleSubscribe(m *msg) error {
	c.mu.Lock()
	if c.up != nil {
		c.mu.Unlock()
		return errAlreadyUpstream
	}
	up, ok := c.room.upstreams[m.ID]
	c.mu.Unlock()
	if !ok {
		return errNoSuchUpstream
	}

	d, err := newDownstream(up, c)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.down[m.ID] = d
	c.mu.Unlock()

	return d.negotiate(c, m.ID)
}
