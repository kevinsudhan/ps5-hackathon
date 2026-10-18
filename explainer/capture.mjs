/**
 * Films the real app for the explainer: drives Chrome over the DevTools protocol with a visible
 * cursor (click ripples, typing), records each clip as a screencast and turns it into a 30 fps JPEG
 * sequence (build/clips/<name>/00001.jpg ...), so index.html can show any frame exactly.
 *
 *   node explainer/capture.mjs                 # every clip, app at http://localhost:5173
 *   node explainer/capture.mjs ask views       # only these (state carries over in order)
 *
 * The clips run a real agent run on Singapore (requested by Kevin, approved by Pranay) and one on
 * LA / Long Beach, so they add runs to the demo memory.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP ?? "http://localhost:5173";
const ONLY = process.argv.slice(2);
const W = 1600, H = 900, DSF = 1.2;            // laptop-sized layout, filmed at 1920x1080
const FPS = 30;
const CHROME = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && existsSync(p));
const OUT = join(here, "build", "clips");
mkdirSync(OUT, { recursive: true });

// ---- Chrome over CDP -------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "pg-explainer-"));
const PORT = 9620 + Math.floor(Math.random() * 100);
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 80 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(150); } }
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map(), listeners = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { ok, no } = pending.get(m.id); pending.delete(m.id); m.error ? no(new Error(m.error.message)) : ok(m.result); return; }
  for (const fn of listeners.get(m.method) ?? []) fn(m.params);
};
const send = (method, params = {}) => new Promise((ok, no) => { const id = ++seq; pending.set(id, { ok, no }); ws.send(JSON.stringify({ id, method, params })); });
const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: false });

const waitFor = async (cond, ms = 30000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) {
    try { if (await js(cond)) return; } catch { /* the page is between documents */ }
  }
  throw new Error(`timed out: ${cond.slice(0, 80)}`);
};
const waitText = (t, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(t)})`, ms);

// ---- a visible cursor ------------------------------------------------------------------------
const CURSOR = `(() => { if (document.getElementById('__cur')) return;
  const st = document.createElement('style');
  st.textContent = '#__cur{position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(800px,600px);transition:transform 650ms cubic-bezier(.25,.8,.25,1);filter:drop-shadow(0 3px 5px rgba(0,0,0,.55))}'
    + '#__rip{position:fixed;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2.5px solid rgba(241,238,246,.95);background:rgba(146,161,194,.25);z-index:2147483646;pointer-events:none;opacity:0}'
    + '#__rip.go{animation:__rip 520ms ease-out}@keyframes __rip{from{opacity:1;transform:scale(.25)}to{opacity:0;transform:scale(1.35)}}';
  document.head.appendChild(st);
  const c = document.createElement('div'); c.id = '__cur';
  c.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 2.5 L4 19.5 L8.6 15.4 L11.6 22 L14.6 20.6 L11.7 14.2 L18 14.2 Z" fill="#F1EEF6" stroke="#1E2340" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  const r = document.createElement('div'); r.id = '__rip'; document.body.appendChild(r);
})()`;
let cur = { x: 800, y: 600 };
const moveTo = async (x, y, ms = 650) => {
  await js(`(() => { const c = document.getElementById('__cur'); c.style.transitionDuration = '${ms}ms'; c.style.transform = 'translate(${x}px, ${y}px)'; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  cur = { x, y };
  await sleep(ms + 60);
};
const center = (finder) => js(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
const byText = (sel, text) => `() => [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().includes(${JSON.stringify(text)}) && !e.disabled)`;
const bySel = (sel) => `() => document.querySelector(${JSON.stringify(sel)})`;
const click = async (finder, { ms = 650, settle = 150 } = {}) => {
  const p = await center(finder);
  if (!p) throw new Error(`nothing to click: ${finder.slice(0, 90)}`);
  await moveTo(p.x, p.y, ms);
  await js(`(() => { const r = document.getElementById('__rip'); r.style.left = '${p.x}px'; r.style.top = '${p.y}px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await sleep(settle);
};
const type = async (text, per = 42) => { for (const ch of text) { await send("Input.insertText", { text: ch }); await sleep(per); } };
const clearInput = (sel) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); i.select(); })()`).then(() => send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }));
const enter = async () => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
};
const escape = () => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
const view = (label) => click(byText(".segmented.small button", label));
const chip = (label) => click(byText(".chip", label));

// ---- screencast recording ----------------------------------------------------------------------
let frames = null;
on("Page.screencastFrame", (p) => {
  send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  if (frames) frames.push({ t: p.metadata.timestamp, data: p.data });
});
let t0 = 0;
const start = async () => {
  frames = [];
  await send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: W * DSF, maxHeight: H * DSF, everyNthFrame: 1 });
  // a first frame of the current state, then the clock starts
  await js(`document.body.style.outline = '0px solid transparent'`);
  for (let i = 0; i < 40 && !frames.length; i++) await sleep(25);
  t0 = Date.now() / 1000;
};
const stop = async (name) => {
  const end = Date.now() / 1000;
  await send("Page.stopScreencast");
  const got = frames;
  frames = null;
  const dir = mkdtempSync(join(tmpdir(), `pg-${name}-`));
  const lines = [];
  got.forEach((f, i) => {
    writeFileSync(join(dir, `${String(i).padStart(5, "0")}.jpg`), Buffer.from(f.data, "base64"));
    const from = Math.max(f.t, t0);
    const to = i + 1 < got.length ? Math.max(got[i + 1].t, t0) : end;
    const d = Math.max(0, to - from);
    if (d > 0 || i === got.length - 1) lines.push(`file '${join(dir, `${String(i).padStart(5, "0")}.jpg`).replace(/\\/g, "/")}'`, `duration ${Math.max(d, 0.001).toFixed(4)}`);
  });
  lines.push(lines[lines.length - 2]);   // the concat demuxer needs the last file twice
  writeFileSync(join(dir, "list.txt"), lines.join("\n"));
  const out = join(OUT, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
    "-vf", `fps=${FPS},scale=${W * DSF}:${H * DSF}:flags=lanczos`, "-q:v", "2", join(out, "%05d.jpg")], { stdio: "inherit" });
  rmSync(dir, { recursive: true, force: true });
  const n = readdirSync(out).length;
  console.log(`  ${name}: ${got.length} screencast frames over ${(end - t0).toFixed(1)}s -> ${n} frames${r.status ? " FAILED" : ""}`);
  return { frames: n, seconds: +(end - t0).toFixed(2) };
};

// ---- the app -----------------------------------------------------------------------------------
const fresh = async () => {
  await send("Page.navigate", { url: APP });
  await sleep(1500);
  await waitFor(`document.readyState === 'complete'`);
  await js(`localStorage.setItem('pg.hint.seen', '1'); localStorage.removeItem('pg.view')`);
  await send("Page.reload", {});
  await sleep(1500);
  await waitText("Orders at risk from Singapore", 30000);
  await sleep(1800);
  await js(CURSOR);
  await moveTo(820, 640, 10);
};
const ensureDiagram = async () => {
  const on2d = await js(`!![...document.querySelectorAll('.segmented.small button')].find(b => b.textContent.trim() === 'Diagram' && b.classList.contains('on'))`);
  if (!on2d && await js(`!![...document.querySelectorAll('.segmented.small button')].find(b => b.textContent.trim() === 'Diagram')`)) await view("Diagram");
};
const answer = async (chipLabel, wait) => { await chip(chipLabel); await waitText(wait, 30000); await sleep(1200); };

const clips = {
  // the landing, then a question typed in plain English
  async ask() {
    await fresh();
    await start();
    await sleep(1500);
    await click(bySel(".ask-box input"), { ms: 800 });
    await type("Which orders are at risk because Singapore closed?", 40);
    await sleep(250);
    await enter();
    await waitText("Singapore's terminals shut", 30000);
    await moveTo(1180, 700, 900);
    await sleep(6200);
    return stop("ask");
  },
  // the same answer on the globe, then "Step by step" beside it
  async views() {
    await start();
    await sleep(400);
    await view("Globe");
    await sleep(4200);
    await click(byText(".stage button", "Step by step"));
    await sleep(1800);
    await click(`() => document.querySelectorAll('.trace-pane li button')[1] || document.querySelectorAll('.trace-pane button')[2]`);
    await sleep(2800);
    const r = await stop("views");
    await click(byText(".stage button", "Step by step"), { ms: 10 });
    await view("Diagram");
    return r;
  },
  // why is Aisha's order late: the chain, then the timeline
  async why() {
    await start();
    await sleep(300);
    await answer("Why is Aisha", "days late");
    await sleep(2200);
    await view("Timeline");
    await sleep(5200);
    return stop("why");
  },
  // four more questions, quickly
  async more() {
    await ensureDiagram();
    await start();
    await sleep(300);
    await answer("10 most loss-inducing orders", "costliest");
    await sleep(1300);
    await answer("What to rescue first", "Rescue");
    await sleep(1300);
    await answer("Places everything depends on", "depends on most");
    await sleep(1300);
    await answer("A way around Singapore", "Fastest way");
    await sleep(2200);
    return stop("more");
  },
  // a real agent run, the approval gate (self-approval blocked), approval, Comms
  async run() {
    await answer("Orders at risk from Singapore", "Singapore's terminals shut");
    await ensureDiagram();
    await start();
    await sleep(500);
    await click(bySel("#requester"), { ms: 700 });
    await js(`document.querySelector('#requester').select()`);
    await type("Kevin Sudhan", 38);
    await click(byText("button", "Run the agents"));
    await waitText("Needs sign-off", 40000);
    await sleep(1800);
    await click(bySel(".approve input"));
    await type("Kevin Sudhan", 38);
    await click(byText(".approve button", "Approve"));
    await waitText("approve your own", 15000);
    await sleep(1900);
    await clearInput(".approve input");
    await type("Pranay J Sathish", 38);
    await click(byText(".approve button", "Approve"));
    await waitText("Approved by", 30000);
    await sleep(2600);
    return stop("run");
  },
  // the run as the graph the agents wrote, then the agents walking the globe
  async agentsview() {
    await js(`document.querySelector('.panel, aside')?.scrollTo?.({ top: 0 })`);
    await start();
    await sleep(400);
    await view("Agents");
    await sleep(4600);
    await view("Globe");
    await sleep(2200);
    await click(bySel(".wm-walk-btn"));
    await sleep(8500);
    const r = await stop("agentsview");
    if (await js(`!!document.querySelector('.wm-walk-btn') && document.querySelector('.wm-walk-btn').textContent.includes('Stop')`)) await click(bySel(".wm-walk-btn"), { ms: 10 });
    await view("Diagram");
    return r;
  },
  // LA / Long Beach: the agents run, memory changed the plan
  async la() {
    await click(byText(".switch-event > button", "Switch disruption"), { ms: 10 });
    await sleep(300);
    await click(byText(".menu button", "LA / Long Beach"), { ms: 10 });
    await waitText("LA / Long Beach labour action", 20000);
    await sleep(1500);
    await answer("Orders at risk", "went on strike");
    await start();
    await sleep(500);
    await click(byText("button", "Run the agents"));
    await waitText("Customers to inform", 40000);
    await sleep(1500);
    await click(byText("button.mem-head", "changed this decision"));
    await sleep(600);
    await js(`document.querySelector('.mem')?.scrollIntoView({ block: 'end', behavior: 'smooth' })`);
    await sleep(4200);
    return stop("la");
  },
  // with and without memory, side by side
  async lacompare() {
    await start();
    await sleep(400);
    await click(byText("button", "Compare with and without memory"));
    await waitText("avoided an expected loss", 30000);
    await sleep(5200);
    const r = await stop("lacompare");
    await escape();
    await sleep(400);
    return r;
  },
  // the engine switch and Compare engines (back on Singapore)
  async engines() {
    await click(byText(".switch-event > button", "Switch disruption"), { ms: 10 });
    await sleep(300);
    await click(byText(".menu button", "Singapore"), { ms: 10 });
    await waitText("Singapore terminals shut", 20000);
    await sleep(1500);
    await answer("Orders at risk from Singapore", "Singapore's terminals shut");
    await ensureDiagram();
    await start();
    await sleep(500);
    await click(byText(".topbar .segmented button", "PostgreSQL"));
    await waitText("Answered by PostgreSQL", 30000);
    await sleep(1800);
    await click(byText("button", "Compare engines"));
    await waitText("Same answer", 30000);
    await sleep(3800);
    const r = await stop("engines");
    await escape();
    await sleep(300);
    await click(byText(".topbar .segmented button", "FalkorDB"), { ms: 10 });
    return r;
  },
};

const manifestPath = join(OUT, "clips.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : {};
try {
  if (ONLY.length && ONLY[0] !== "ask") await fresh();     // later clips start from the app's landing
  for (const [name, fn] of Object.entries(clips)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    console.log(`clip ${name}`);
    manifest[name] = await fn();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  }
} catch (e) {
  console.error("FAILED:", e.message);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, "failure.png"), Buffer.from(data, "base64"));
  process.exitCode = 1;
} finally {
  ws.close();
  spawnSync("taskkill", ["/pid", String(chrome.pid), "/T", "/F"]);
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still holds a file; the temp dir is harmless */ }
}
