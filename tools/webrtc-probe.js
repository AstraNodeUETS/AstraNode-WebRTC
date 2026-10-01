// Prueba automatizada del pipeline WebRTC sin intervencion humana.
//
// Levanta dos perfiles de Chrome con camara falsa: uno hace de celular emisor
// (/join) y otro de panel (/view). Es la unica forma de comprobar en esta
// maquina que los paquetes RTP llegan de verdad, porque no hay celulares fisicos.
//
// Uso: node tools/webrtc-probe.js <urlBase>

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const CHROME = process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const BASE = process.argv[2] || "https://192.168.0.101:8443";
const WAIT_MS = 25000;
const DEBUG_PORT = 9333;

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function launchChrome(profileDir, port) {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--ignore-certificate-errors",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ];
  return spawn(CHROME, args, { stdio: "ignore" });
}

async function main() {
  const tmp = path.join(os.tmpdir(), "astra-probe-" + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  console.log("perfil temporal:", tmp);
  const chrome = launchChrome(tmp, DEBUG_PORT);

  // Darle tiempo a Chrome a levantar el puerto de depuracion.
  let version = null;
  for (let i = 0; i < 40; i++) {
    try {
      version = await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      break;
    } catch (e) {
      await sleep(500);
    }
  }
  if (!version) {
    console.error("ERROR: Chrome no abrio el puerto de depuracion");
    chrome.kill();
    process.exit(1);
  }
  console.log("Chrome listo:", version["Browser"]);

  // Node 22+ trae WebSocket global; no hace falta instalar nada.
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  };

  function send(method, params = {}, sessionId) {
    const mid = ++id;
    const payload = { id: mid, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
  }

  async function newPage(url) {
    const t = await send("Target.createTarget", { url });
    const a = await send("Target.attachToTarget", {
      targetId: t.targetId,
      flatten: true,
    });
    const session = a.sessionId;
    await send("Runtime.enable", {}, session);
    return session;
  }

  async function evalJS(session, expression) {
    const r = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      session
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " " +
        JSON.stringify(r.exceptionDetails.exception || {}));
    }
    return r.result.value;
  }

  console.log("abriendo emisor y espectador...");
  const emisor = await newPage(BASE + "/join?name=probe-phone");
  const espectador = await newPage(BASE + "/view");

  // El emisor es una pagina de celular: hay que pulsar "Conectar" a mano.
  console.log("presionando Conectar en la pagina del emisor...");
  await evalJS(
    emisor,
    `document.getElementById('name').value='probe-phone';
     document.getElementById('go').click();
     'clicked'`
  );

  console.log(`esperando hasta ${WAIT_MS / 1000}s a que llegue video...`);
  const deadline = Date.now() + WAIT_MS;
  let stats = null;

  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      stats = await evalJS(
        espectador,
        `(function(){
           var v = document.getElementById('v');
           if (!v) return { error: 'sin elemento video' };
           var s = v.srcObject;
           return {
             hasStream: !!s,
             tracks: s ? s.getTracks().map(function(t){ return t.kind; }) : [],
             videoWidth: v.videoWidth,
             videoHeight: v.videoHeight,
             readyState: v.readyState,
             waitVisible: getComputedStyle(document.getElementById('wait')).display !== 'none'
           };
         })()`
      );
    } catch (e) {
      stats = { error: String(e) };
    }
    if (stats && stats.videoWidth > 0) break;
  }

  console.log("\n--- estado del espectador ---");
  console.log(JSON.stringify(stats, null, 2));

  const ok = stats && stats.videoWidth > 0 && stats.hasStream;
  console.log(ok ? "\nRESULTADO: OK - el video llego al espectador"
                 : "\nRESULTADO: FALLO - no llego video");

  chrome.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("error fatal:", e);
  process.exit(1);
});
