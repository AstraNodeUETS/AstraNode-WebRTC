// Vista limpia de un solo emisor, pensada para el Browser Source de OBS.
//
// Es casi identico al panel, pero sin interfaz: OBS no necesita barras de
// botones ni nombres, solo el video ocupando todo el espacio. Si el parametro
// ?peer= no viene, muestra el primer emisor disponible.
(function () {
  "use strict";

  var video = document.getElementById("v");
  var wait = document.getElementById("wait");

  var params = new URLSearchParams(location.search);
  var wanted = params.get("peer");

  var ws = null;
  var pc = null;
  var seen = {}; // evita suscribirse dos veces al mismo emisor

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

      if (m.type === "peers") {
        (m.peers || []).forEach(pick);
      } else if (m.type === "upstream-ready" && m.peer) {
        pick(m.peer);
      } else if (m.type === "offer") {
        onOffer(m);
      } else if (m.type === "peer-left" && m.id === wanted) {
        // La fuente se fue: OBS mostrara un cuadro vacio, que es lo honesto
        // que hacer en vez de congelar la ultima imagen.
        video.srcObject = null;
        wait.style.display = "block";
        wait.textContent = "La fuente se desconecto";
        if (pc) {
          try {
            pc.close();
          } catch (e) {
            /* ya estaba cerrado */
          }
          pc = null;
        }
        seen = {};
      }
    };

    ws.onclose = function () {
      setTimeout(connect, 2000);
    };
  }

  function pick(peer) {
    // Con ?peer= nos quedamos solo con esa fuente. Sin el, tomamos la primera.
    if (wanted && peer.id !== wanted) {
      return;
    }
    if (seen[peer.id] || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    seen[peer.id] = true;
    ws.send(JSON.stringify({ type: "subscribe", id: peer.id }));
  }

  function onOffer(m) {
    var id = m.id || (m.peer && m.peer.id);
    if (!id) {
      return;
    }
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: "stun:stun.l.google.com:19302" }
      ]
    });

    pc.ontrack = function (ev) {
      video.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      video.play().catch(function () {
        /* el navegador puede rechazar hasta que hay un gesto del usuario */
      });
      wait.style.display = "none";
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
      })
      .catch(function (err) {
        console.error("fallo la negociacion", err);
      });
  }

  connect();
})();
