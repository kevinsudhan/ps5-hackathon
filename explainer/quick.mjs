/**
 * The quick cut: real app footage + simple slides, timed to the narration, captions burned in.
 *   node explainer/quick.mjs   ->  explainer/promise-graph-demo-quick.mp4
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const B = join(here, "build"), Q = join(B, "quick");
mkdirSync(join(Q, "slides"), { recursive: true });
const TL = JSON.parse(readFileSync(join(B, "timeline.json"), "utf-8"));
const S = Object.fromEntries(TL.scenes.map((s) => [s.id, s]));
const run = (args, cwd) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit", cwd }); if (r.status) throw new Error("ffmpeg failed: " + args.join(" ").slice(0, 200)); };

// ---- slides -> PNG ---------------------------------------------------------------------------
const SLIDES = ["problem", "ripple", "title", "model", "agents", "memory", "flip", "falkor", "outro"];
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = mkdtempSync(join(tmpdir(), "pg-slides-"));
const PORT = 9730 + Math.floor(Math.random() * 60);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1920,1080", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list; for (let i = 0; i < 80 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(150); } }
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
for (const s of SLIDES) {
  await send("Page.navigate", { url: pathToFileURL(join(here, "slides.html")).href + "?s=" + s });
  await sleep(900);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(Q, "slides", `${s}.png`), Buffer.from(data, "base64"));
}
ws.close(); spawnSync("taskkill", ["/pid", String(chrome.pid), "/T", "/F"]);
console.log("slides done");

// ---- segments ----------------------------------------------------------------------------------
const V = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", "30"];
const segs = [];
let n = 0;
const slide = (name, dur) => {
  const out = join(Q, `seg${String(++n).padStart(2, "0")}.mp4`);
  run(["-loop", "1", "-framerate", "30", "-i", join(Q, "slides", `${name}.png`), "-t", dur.toFixed(3), "-vf", "fade=in:st=0:d=0.35", ...V, out]);
  segs.push(out);
};
const clip = (name, start, speed, dur) => {
  const out = join(Q, `seg${String(++n).padStart(2, "0")}.mp4`);
  run(["-framerate", "30", "-start_number", String(Math.max(1, Math.round(start * 30) + 1)), "-i", join(B, "clips", name, "%05d.jpg"),
    "-vf", `setpts=PTS/${speed},fps=30,tpad=stop_mode=clone:stop_duration=30,fade=in:st=0:d=0.3`, "-t", dur.toFixed(3), ...V, out]);
  segs.push(out);
};
const d = (id) => S[id].end - S[id].start;
slide("problem", d("promise") + d("closure"));
slide("ripple", d("ripple"));
slide("title", d("title"));
slide("model", d("model"));
clip("ask", 1.4, 1.0, d("ask"));
clip("views", 1.4, 1.2, d("views"));
clip("why", 0.8, 1.22, d("why"));
clip("more", 1.6, 1.9, d("more"));
slide("agents", d("agents"));
clip("run", 2.6, 1.1, d("run"));
clip("agentsview", 2.0, 2.1, d("agentsview"));
slide("memory", d("memory"));
slide("flip", 15.0);
clip("la", 4.0, 1.0, d("flip") - 15.0);
clip("lacompare", 0.4, 0.75, d("proofmem"));
clip("engines", 2.5, 1.0, 6.0);
slide("falkor", d("falkor") - 6.0);
slide("outro", d("outro"));
writeFileSync(join(Q, "list.txt"), segs.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"));
console.log("segments done");

// ---- join, narration, captions -----------------------------------------------------------------
copyFileSync(join(here, "promise-graph-explainer.srt"), join(Q, "caps.srt"));
copyFileSync(join(B, "narration.wav"), join(Q, "narration.wav"));
const style = "FontName=Segoe UI,Fontsize=17,PrimaryColour=&H00F6EEF1,OutlineColour=&H80281E1E,BackColour=&H90402320,BorderStyle=4,Outline=0,Shadow=0,MarginV=26,Bold=1";
run(["-f", "concat", "-safe", "0", "-i", "list.txt", "-i", "narration.wav",
  "-vf", `subtitles=caps.srt:force_style='${style}'`, ...V, "-c:a", "aac", "-b:a", "192k",
  "-af", "apad,loudnorm=I=-16:TP=-1.5:LRA=11", "-shortest", "-movflags", "+faststart", join(here, "promise-graph-demo-quick.mp4")], Q);
console.log("done:", join(here, "promise-graph-demo-quick.mp4"));
