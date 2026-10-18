/**
 * Renders promo/index.html to an MP4, frame by frame — no dependencies beyond Chrome and ffmpeg.
 *
 *   node promo/render.mjs                         # promo/promise-graph-demo.mp4, 1920×1080, 30 fps
 *   node promo/render.mjs --stills 2.5,15,46      # promo/stills/*.jpg, to check frames first
 *   node promo/render.mjs --fps 60 --out x.mp4
 *   node promo/render.mjs --cues                  # build/cues.json, the sound cues the page lists, for audio.py
 *
 * The whole promo: python promo/voice.py → node promo/render.mjs --cues → python promo/audio.py → node promo/render.mjs.
 * build/mix.wav, when it exists, becomes the video's sound track.
 *
 * The page paints any time t exactly (window.__seek), so each frame is set, captured as a
 * screenshot over the DevTools protocol, and piped into ffmpeg. Nothing plays in real time,
 * so a slow machine makes a slower render, never a choppier video.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const FPS = Number(opt("--fps", "30"));
const OUT = resolve(opt("--out", join(here, "promise-graph-demo.mp4")));
const STILLS = opt("--stills", null);
const CUES = args.includes("--cues");
const AUDIO = resolve(opt("--audio", join(here, "build", "mix.wav")));
const CHROME = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("no Chrome found — set CHROME to its path");

// ------------------------------------------------------------ a static server with ranges
const TYPES = { ".json": "application/json", ".wav": "audio/wav", ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".png": "image/png", ".mp4": "video/mp4", ".webm": "video/webm", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = resolve(here, "." + decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!path.startsWith(here) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404).end(); return; }
  const size = statSync(path).size;
  const type = TYPES[extname(path)] ?? "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    createReadStream(path).pipe(res);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ------------------------------------------------------------ Chrome, over the DevTools protocol
const profile = mkdtempSync(join(tmpdir(), "promo-chrome-"));
const DEBUG = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`,
  "--window-size=1920,1080", "--force-device-scale-factor=1", "--hide-scrollbars", "--mute-audio",
  "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  "about:blank",
], { stdio: "ignore" });

async function targets() {
  for (let i = 0; i < 80; i++) {
    try { return await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json(); } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error("Chrome did not start");
}
const page = (await targets()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const waiters = [];
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
  if (m.id && pending.has(m.id)) { const { ok, no } = pending.get(m.id); pending.delete(m.id); m.error ? no(new Error(`${m.error.message}`)) : ok(m.result); return; }
  for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.ok(m.params); }
};
const send = (method, params = {}) => new Promise((ok, no) => { const id = ++seq; pending.set(id, { ok, no }); ws.send(JSON.stringify({ id, method, params })); });
const once = (method) => new Promise((ok) => waiters.push({ method, ok }));
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const loaded = once("Page.loadEventFired");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html?render=1` });
await loaded;
await evaluate("window.__ready.then(() => true)");
const DURATION = await evaluate("window.__duration");

const shot = async (t) => {
  await evaluate(`window.__seek(${t.toFixed(4)})`);
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 95, fromSurface: true });
  return Buffer.from(data, "base64");
};

function finish() {
  try { ws.close(); } catch { /* closed */ }
  chrome.kill();
  server.close();
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold it */ } }, 800);
}

try {
  if (CUES) {
    mkdirSync(join(here, "build"), { recursive: true });
    const cues = await evaluate("window.__cues");
    writeFileSync(join(here, "build", "cues.json"), JSON.stringify(cues, null, 1));
    console.log(`wrote build/cues.json (${cues.length} cues, ${DURATION}s)`);
  } else if (STILLS) {
    const dir = join(here, "stills");
    mkdirSync(dir, { recursive: true });
    for (const t of STILLS.split(",").map(Number)) {
      writeFileSync(join(dir, `t-${String(t).padStart(5, "0")}.jpg`), await shot(t));
      console.log(`still at ${t}s`);
    }
  } else {
    const frames = Math.round(DURATION * FPS);
    const sound = existsSync(AUDIO) ? ["-i", AUDIO, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "256k", "-shortest"] : [];
    if (!sound.length) console.log(`no ${AUDIO} — rendering without sound`);
    const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", ...sound,
      // Screenshots are full-range JPEG; players expect TV-range BT.709, or the video looks washed out.
      "-vf", "scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p",
      "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart", OUT], { stdio: ["pipe", "inherit", "inherit"] });
    const started = Date.now();
    for (let i = 0; i < frames; i++) {
      const buf = await shot(i / FPS);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      if (i % FPS === 0) {
        const done = (i + 1) / frames;
        const eta = ((Date.now() - started) / done) * (1 - done) / 1000;
        process.stdout.write(`\rframe ${i + 1}/${frames}  ${(done * 100).toFixed(1)}%  ~${Math.round(eta)}s left   `);
      }
    }
    ff.stdin.end();
    await new Promise((r, j) => ff.on("close", (code) => (code === 0 ? r() : j(new Error(`ffmpeg exited ${code}`)))));
    console.log(`\nwrote ${OUT} (${frames} frames, ${(statSync(OUT).size / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - started) / 1000)}s`);
  }
} finally {
  finish();
}
