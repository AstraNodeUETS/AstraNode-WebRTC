// Pagina del celular: publica video al servidor.
//
// El servidor envia una oferta ("mandame video"), esta pagina responde, y a
// partir de ahi el navegador envia los paquetes RTP directamente. El navegador
// nunca negocia por su cuenta: el flujo lo manda el servidor.
(function () {
  "use strict";

  var el = {
    name: document.getElementById("name"),
    res: document.getElementById("res"),
    sub: document.getElementById("sub"),
    preview: document.getElementById("preview"),
    previewEmpty: document.getElementById("previewEmpty"),
    status: document.getElementById("status"),
    toggleCam: document.getElementById("toggleCam"),
    camera: document.getElementById("camera"),
    go: document.getElementById("go"),
    hint: document.getElementById("hint")
  };

  // Mapa de altura a las restricciones que entiende getUserMedia. Fijar el
  // alto exacto es lo que hace que el celular no intente escalar un video de
  // 4K a 720p y recaliente la CPU.
  var PROFILES = {
    "360": { width: 640, height: 360, frameRate: 24 },
    "720": { width: 1280, height: 720, frameRate: 30 },
    "1080": { width: 1920, height: 1080, frameRate: 30 }
  };

  var ws = null;
  var pc = null;
  var stream = null;
  var publishing = false;
  var connecting = false;
  var camOn = false;

  // Un telefono que se apaga deja de enviar video. WakeLock evita que la
  // pantalla se bloquee y corte la transmision a mitad de una toma.
  var wakeLock = null;

  function setStatus(text, state) {
    el.status.textContent = text;
    el.status.dataset.state = state;
  }

  function setHint(text) {
    el.hint.textContent = text;
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

  // ---- Camara -------------------------------------------------------------

  function constraints() {
    var p = PROFILES[el.res.value] || PROFILES["720"];
    return {
      audio: false, // por ahora solo video; el microfono se puede anadir despues
      video: {
        width: { ideal: p.width },
        height: { ideal: p.height },
        frameRate: { ideal: p.frameRate },
        facingMode: { ideal: el.camera.value }
      }
    };
  }

  function startCamera() {
    return navigator.mediaDevices
      .getUserMedia(constraints())
      .then(function (s) {
        stream = s;
        el.preview.srcObject = s;
        el.preview.dataset.camera = el.camera.value;
        camOn = true;
        el.previewEmpty.style.display = "none";
        el.toggleCam.disabled = false;
        el.toggleCam.textContent = "Apagar camara";
        el.go.disabled = false;
        setStatus("Camara lista", "ready");
        setHint("Presiona Conectar para enviar el video al panel.");
        return s;
      })
      .catch(function (err) {
        onCameraError(err);
        throw err;
      });
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
    }
    stream = null;
    camOn = false;
    el.preview.srcObject = null;
    el.previewEmpty.style.display = "flex";
    el.toggleCam.textContent = "Encender camara";
    el.toggleCam.disabled = true;
    el.camera.disabled = false;
    el.go.disabled = true;
    setStatus("Camara apagada", "idle");
  }

  function onCameraError(err) {
    var msg;
    if (!navigator.mediaDevices) {
      msg =
        "Este navegador no expone la camara. " +
        "Abre la pagina en Chrome o Safari, no en un modo privado.";
    } else if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      msg =
        "No se dio permiso para usar la camara. " +
        "Si estas en un celular, revisa que la pagina se este sirviendo por HTTPS " +
        "(direccion https://) y no por http://.";
    } else if (err && err.name === "NotFoundError") {
      msg = "No se encontro ninguna camara en este dispositivo.";
    } else {
      msg = "No se pudo abrir la camara: " + (err && err.name ? err.name : "error desconocido");
    }
    setStatus("Error de camara", "error");
    setHint(msg);
    el.sub.textContent = "Sin camara";
  }

  // ---- WebSocket ----------------------------------------------------------

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws");

    ws.onopen = function () {
      ws.send(
        JSON.stringify({
          type: "join",
          role: "upstream",
          name: el.name.value.trim() || "celular"
        })
      );
    };

    ws.onmessage = function (ev) {
      var m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m.type === "offer") {
        onOffer(m.sdp);
      } else if (m.type === "error") {
        setStatus("Error del servidor", "error");
        setHint(m.error || "Error desconocido del servidor");
      }
    };

    ws.onclose = function () {
      if (publishing) {
        setStatus("Desconectado del servidor", "error");
        setHint("Se perdio la conexion. Presiona Conectar para reconectar.");
        el.go.disabled = false;
        el.go.textContent = "Reconectar";
      }
    };

    ws.onerror = function () {
      setStatus("No se pudo conectar", "error");
    };
  }

  // ---- Negociacion -------------------------------------------------------

  function onOffer(sdp) {
    if (!stream) {
      return;
    }
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: "stun:stun.l.google.com:19302" }
      ]
    });

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "connected") {
        setStatus("Transmitiendo", "live");
        setHint("El panel ya deberia mostrar tu video.");
      } else if (pc.connectionState === "failed") {
        publishing = false;
        el.go.disabled = false;
        el.go.textContent = "Reconectar";
        setStatus("Conexion fallida", "error");
        setHint(
          "La señalizacion funciona, pero la red no permite transportar el video. " +
          "Configura un servidor TURN o conecta ambos dispositivos a la misma red."
        );
      }
    };

    // El orden importa. El servidor ofrece un transceiver recvonly; hay que
    // aplicar esa oferta ANTES de enganchar la camara, para que el navegador
    // reutilice ese transceiver en vez de crear otro y desalinear las m-line.
    // Si se llama addTrack antes de setRemoteDescription, la respuesta queda
    // con un orden distinto al de la oferta y el servidor nunca recibe video.
    pc.setRemoteDescription({ type: "offer", sdp: sdp })
      .then(function () {
        return attachCamera();
      })
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
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error("el servidor cerro la senalizacion");
        }
        ws.send(
          JSON.stringify({
            type: "answer",
            sdp: pc.localDescription.sdp
          })
        );
        publishing = true;
        connecting = false;
        el.camera.disabled = true;
        el.go.textContent = "Conectado";
        el.go.disabled = true;
        setStatus("Conectando video...", "pending");
        setHint("Esperando que ICE establezca la ruta de video.");
        requestWakeLock();
      })
      .catch(function (err) {
        connecting = false;
        publishing = false;
        if (pc) {
          pc.close();
          pc = null;
        }
        if (ws) {
          ws.close();
          ws = null;
        }
        el.camera.disabled = false;
        el.go.disabled = false;
        setStatus("Error de negociacion", "error");
        setHint("No se pudo completar la negociacion: " + (err.message || err.name));
      });
  }

  // Engancha la camara al transceiver que el servidor ofrecio.
  function attachCamera() {
    var videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      return Promise.reject(new Error("la camara no tiene pista de video"));
    }

    var tr = null;
    pc.getTransceivers().forEach(function (t) {
      if (t.receiver.track && t.receiver.track.kind === "video" && !t.sender.track) {
        tr = t;
      }
    });

    if (!tr) {
      // Si el servidor no ofrecio video, anadir uno nuevo exigiria
      // renegociar, y aqui no hay a quien renegociarle.
      return Promise.reject(
        new Error("el servidor no ofrecio un transceiver de video")
      );
    }

    tr.direction = "sendonly";
    return tr.sender.replaceTrack(videoTrack);
  }

  // WakeLock: mantener la pantalla encendida mientras se transmite.
  function requestWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock) {
      return;
    }
    navigator.wakeLock
      .request("screen")
      .then(function (lock) {
        wakeLock = lock;
        lock.addEventListener("release", function () {
          wakeLock = null;
        });
      })
      .catch(function () {
        // Si no se puede, el video sigue funcionando: solo se apaga la
        // pantalla. No es motivo para mostrar un error.
      });
  }

  // ---- Eventos -----------------------------------------------------------

  el.go.addEventListener("click", function () {
    if (publishing || connecting) {
      return;
    }
    connecting = true;
    el.go.disabled = true;
    setStatus("Conectando...", "pending");
    var ready = stream ? Promise.resolve(stream) : startCamera();
    ready.then(connect).catch(function () {
      connecting = false;
      el.go.disabled = false;
    });
  });

  el.toggleCam.addEventListener("click", function () {
    if (camOn) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  // Cambiar la calidad requiere reiniciar el track antes de conectar.
  el.res.addEventListener("change", function () {
    if (!camOn || publishing) {
      return;
    }
    stopCamera();
    startCamera();
  });

  el.camera.addEventListener("change", function () {
    if (!camOn || publishing) {
      return;
    }
    stopCamera();
    startCamera();
  });

  window.addEventListener("beforeunload", function () {
    if (ws) {
      ws.send(JSON.stringify({ type: "bye" }));
      ws.close();
    }
  });

  // Arrancamos pidiendo la camara de inmediato: en iOS el permiso solo aparece
  // si se pide desde un evento del usuario, y hay que aprovechar el toque.
  el.go.addEventListener(
    "click",
    function () {
      requestWakeLock();
    },
    { once: true }
  );

  startCamera().catch(function () {
    /* el error ya se mostro en onCameraError */
  });
})();
