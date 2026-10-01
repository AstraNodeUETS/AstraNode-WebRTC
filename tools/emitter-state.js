// Diagnostico puntual: reporta el estado interno de la pagina del emisor.
// Sirve para separar "el navegador no Ilego a pedir camara" de "el servidor
// recibio la oferta pero no hay video".
//
// Uso: node tools/emitter-state.js <urlBase>

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const CHROME = process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.argv[2] || "https://192.168.0.101:8443";
const PORT = 9334;

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmp = path.join(os.tmpdir(), "astra-diag-" + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  const chrome = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--ignore-certificate-errors",
    `--user-data-dir=${tmp}`, `--remote-debugging-port=${PORT}`, "about:blank",
  ], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch (e) { await sleep(500); }
  }
  if (!version) { console.error("Chrome no arranco"); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  const exceptions = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method === "Runtime.consoleAPICalled") {
      consoleLines.push(m.params.type + ": " +
        m.params.args.map((a) => a.value ?? a.description ?? "?").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      exceptions.push(m.params.exceptionDetails.text + " " +
        (m.params.exceptionDetails.exception?.description || ""));
    }
  };

  const send = (method, params = {}, sessionId) => {
    const mid = ++id;
    const payload = { id: mid, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
  };

  const t = await send("Target.createTarget", { url: BASE + "/join?name=diag" });
  const a = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const s = a.sessionId;
  await send("Runtime.enable", {}, s);
  await send("Log.enable", {}, s);

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate",
      { expression: expr, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) {
      return { EXCEPTION: r.exceptionDetails.text + " " +
        JSON.stringify(r.exceptionDetails.exception || {}) };
    }
    return r.result.value;
  };

  await sleep(4000);

  console.log("=== 1. permisos / camara ===");
  console.log(await ev(`(async function(){
    var out = {
      hasMediaDevices: !!navigator.mediaDevices,
      isSecureContext: window.isSecureContext,
      goDisabled: document.getElementById('go').disabled,
      status: document.getElementById('status').textContent,
      statusState: document.getElementById('status').dataset.state,
      hint: document.getElementById('hint').textContent.slice(0,140)
    };
    try {
      var s = await navigator.mediaDevices.getUserMedia({video:true});
      out.gum = 'OK, ' + s.getVideoTracks().length + ' track(s)';
    } catch(e) { out.gum = 'FALLO ' + e.name + ': ' + e.message; }
    return out;
  })()`));

  console.log("\n=== 2. clic en Conectar ===");
  console.log(await ev(`(function(){
    document.getElementById('name').value = 'diag-phone';
    var b = document.getElementById('go');
    var wasDisabled = b.disabled;
    b.click();
    return { goWasDisabled: wasDisabled, clicked: true };
  })()`));

  await sleep(10000);

  console.log("\n=== 3. estado tras 10s ===");
  console.log(await ev(`(function(){
    var v = document.getElementById('preview');
    return {
      status: document.getElementById('status').textContent,
      statusState: document.getElementById('status').dataset.state,
      hint: document.getElementById('hint').textContent.slice(0,160),
      goText: document.getElementById('go').textContent,
      goDisabled: document.getElementById('go').disabled,
      previewHasStream: !!v.srcObject,
      previewSize: v.videoWidth + 'x' + v.videoHeight
    };
  })()`));

  console.log("\n=== consola del navegador ===");
  console.log(consoleLines.length ? consoleLines.join("\n") : "(vacia)");
  console.log("\n=== excepciones ===");
  console.log(exceptions.length ? exceptions.join("\n") : "(ninguna)");

  chrome.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
