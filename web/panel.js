// Panel de control: muestra el video de cada celular conectado y genera los
// enlaces que OBS consume.
//
// Este script no toca video entrante salvo para pedirlo: recibe un <video> por
// celador, se suscribe al emisor correspondiente y reproduce.
(function () {
  "use strict";

  var el = {
    grid: document.getElementById("grid"),
    empty: document.getElementById("empty"),
    count: document.getElementById("count"),
    sub: document.getElementById("sub"),
    joinUrl: document.getElementById("joinUrl"),
    joinLink: document.getElementById("joinLink")
  };

  // id de emisor -> { video, card }
  var tiles = {};

  var ws = null;
  var pending = {}; // id de emisor -> RTCPeerConnection a medio construir

  function origin() {
    return location.origin;
  }

  function setSub(text) {
    el.sub.textContent = text;
  }

  function waitForIceGathering(connection, timeoutMs) {
    if (connection.iceGatheringState === "complete") {
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var timer = setTimeout(resolve, timeoutMs || 5000);
      function onStateChange() {
        if (connection.iceGatheringState === "complete") {
          connection.removeEventListener("icegatheringstatechange", onStateChange);
          clearTimeout(timer);
          resolve();
        }
      }
      connection.addEventListener("icegatheringstatechange", onStateChange);
    });
  }

  // ---- Tarjetas ----------------------------------------------------------

  function createTile(peer) {
    var card = document.createElement("article");
    card.className = "card";

    var video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // los navegadores bloquean el autoplay con sonido
    video.setAttribute("playsinline", "");
    card.appendChild(video);

    var bar = document.createElement("div");
    bar.className = "card-bar";

    var name = document.createElement("span");
    name.className = "card-name";
    name.textContent = peer.name;
    bar.appendChild(name);

    var obsBtn = document.createElement("button");
    obsBtn.className = "btn btn-sm btn-ghost";
    obsBtn.textContent = "Copiar enlace OBS";
    obsBtn.addEventListener("click", function () {
      copyObsLink(peer, obsBtn);
    });
    bar.appendChild(obsBtn);

    card.appendChild(bar);
    el.grid.appendChild(card);

    // Al copiar se lleva el id del emisor, para que /view sepa a quien mirar.
    return { video: video, card: card, name: name };
  }

  function copyObsLink(peer, btn) {
    var url = origin() + "/view?peer=" + encodeURIComponent(peer.id);
    copyText(url);
    var prev = btn.textContent;
    btn.textContent = "Copiado";
    setTimeout(function () {
      btn.textContent = prev;
    }, 1500);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  // localhost es un contexto seguro, pero abrir el panel desde la IP de la LAN
  // no lo es, y navigator.clipboard puede no existir ahi.
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      window.prompt("Copia este enlace para OBS:", text);
    }
    document.body.removeChild(ta);
  }

  // ---- Suscripcion -------------------------------------------------------

  // Suscribirse es pedirle al servidor que nos cree una conexion de salida.
  // El servidor responde con una oferta que hay que completar.
  function subscribe(peer) {
    if (tiles[peer.id] || pending[peer.id]) {
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({ type: "subscribe", id: peer.id }));
  }

  function onOffer(m) {
    // Las ofertas del servidor identifican al emisor dentro de "peer".
    // Aceptar tambien "id" mantiene compatible el cliente con ofertas simples.
    var id = m.id || (m.peer && m.peer.id);
    if (!id) {
      return;
    }
    var tile = tiles[id];
    if (!tile) {
      return;
    }

    var pc = new RTCPeerConnection({ iceServers: [] });
    pending[id] = pc;

    pc.ontrack = function (ev) {
      tile.video.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      tile.video.play().catch(function () {
        // algunos navegadores rechazan play() si el elemento esta oculto; el
        // video sigue funcionando cuando el usuario lo ve.
      });
    };

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        removeTile(id);
      }
    };

    pc.setRemoteDescription({ type: "offer", sdp: m.sdp })
      .then(function () {
        return pc.createAnswer();
      })
      .then(function (answer) {
        return pc.setLocalDescription(answer);
      })
      .then(function () {
        return waitForIceGathering(pc);
      })
      .then(function () {
        ws.send(
          JSON.stringify({
            type: "answer",
            id: id,
            sdp: pc.localDescription.sdp
          })
        );
        delete pending[id];
      })
      .catch(function (err) {
        console.error("fallo la negociacion con " + id, err);
        delete pending[id];
      });
  }

  function removeTile(id) {
    var tile = tiles[id];
    if (!tile) {
      return;
    }
    if (pending[id]) {
      try {
        pending[id].close();
      } catch (e) {
        /* ya estaba cerrado */
      }
      delete pending[id];
    }
    tile.card.remove();
    delete tiles[id];
    refresh();
  }

  function refresh() {
    var n = Object.keys(tiles).length;
    el.count.textContent = n === 1 ? "1 fuente" : n + " fuentes";
    el.empty.style.display = n === 0 ? "flex" : "none";
    setSub(n === 0 ? "Esperando celulares" : "Transmitiendo " + n + " fuente" + (n === 1 ? "" : "s"));
  }

  // ---- WebSocket ---------------------------------------------------------

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws");

    ws.onopen = function () {
      ws.send(JSON.stringify({ type: "join", role: "downstream" }));
    };

    ws.onmessage = function (ev) {
      var m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }

      switch (m.type) {
        case "peers":
          (m.peers || []).forEach(addPeer);
          refresh();
          break;

        case "upstream-ready":
          if (m.peer) {
            addPeer(m.peer);
            refresh();
          }
          break;

        case "offer":
          onOffer(m);
          break;

        case "peer-left":
          if (m.id) {
            removeTile(m.id);
          }
          break;

        case "error":
          console.error("servidor:", m.error);
          setSub("Error: " + m.error);
          break;
      }
    };

    ws.onclose = function () {
      setSub("Reconectando...");
      // Si el servidor se reinicia, las tiles viejas son invalidas.
      Object.keys(tiles).forEach(removeTile);
      setTimeout(connect, 2000);
    };

    ws.onerror = function () {
      setSub("Sin conexion con el servidor");
    };
  }

  function addPeer(peer) {
    if (tiles[peer.id]) {
      return;
    }
    tiles[peer.id] = createTile(peer);
    subscribe(peer);
  }

  // ---- Arranque ----------------------------------------------------------

  var joinUrl = origin() + "/join";
  el.joinUrl.textContent = joinUrl;
  el.joinLink.href = joinUrl;
  el.joinUrl.addEventListener("click", function () {
    copyText(joinUrl);
  });

  refresh();
  connect();
})();
