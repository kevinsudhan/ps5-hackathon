/**
 * Films the real app for the demo video: drives Chrome over the DevTools protocol, shows a cursor
 * with click ripples, and records each clip as a screencast, then encodes it as an all-intra MP4
 * (every frame a keyframe, so index.html can seek it exactly while rendering).
 *
 *   node video/capture.mjs                      # every clip, app at http://127.0.0.1:8000
 *   node video/capture.mjs ask split            # only these clips (state carries over in order)
 *   APP=http://127.0.0.1:8000 node video/capture.mjs
 *
 * Needs the app on one API process (docker compose --profile app, or uvicorn serving frontend/dist),
 * and scripts.reset_demo afterwards: the clips run and approve a real agent run.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP ?? "http://127.0.0.1:8000";
const ONLY = process.argv.slice(2);
const W = 1600, H = 900, DSF = 1.5;          // a laptop-sized layout, filmed at 2400x1350
const FPS = 30;
const CHROME = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("no Chrome found: set CHROME");
const OUT = join(here, "clips");
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ Chrome over CDP
const profile = mkdtempSync(join(tmpdir(), "pg-capture-"));
const DEBUG = 9800 + Math.floor(Math.random() * 150);
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
  "--use-angle=d3d11", "--enable-gpu-rasterization", "--ignore-gpu-blocklist",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 80 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json(); } catch { await sleep(150); } }
const target = list.find((t) => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const listeners = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
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

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: false });

// ------------------------------------------------------------------ a visible cursor, in the page
const CURSOR = `(() => {
  if (window.__cur) return;
  const s = document.createElement('style');
  s.textContent = \`#__cur{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;
    transform:translate(-100px,-100px);transition:transform .7s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))}
    .__rip{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid rgba(255,255,255,.9);
    z-index:2147483646;pointer-events:none;animation:__rip .55s ease-out forwards}
    @keyframes __rip{from{transform:scale(.4);opacity:1}to{transform:scale(3.2);opacity:0}}\`;
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur';
  c.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20 L13.4 18.7 L10.4 12.6 L16.5 12.4 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  window.__cur = { x: ${W * 0.62}, y: ${H * 0.55} };
  c.style.transform = 'translate(' + window.__cur.x + 'px,' + window.__cur.y + 'px)';
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  window.__find = (text, sel = 'button,[role=radio],[role=tab],a,summary,[role=button]', exact = false) => {
    const t = text.toLowerCase();
    return [...document.querySelectorAll(sel)].filter(vis).find(e => { const s = (e.textContent || e.getAttribute('aria-label') || '').trim().toLowerCase(); return exact ? s === t : s.startsWith(t); })
      || [...document.querySelectorAll(sel)].filter(vis).find(e => (e.textContent || '').toLowerCase().includes(t));
  };
  window.__point = async (el, ms = 700) => {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    await new Promise(r => setTimeout(r, 120));
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width * 0.5, 60), y = r.top + r.height * 0.5;
    c.style.transition = 'transform ' + ms + 'ms cubic-bezier(.2,.8,.2,1)';
    c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    window.__cur = { x, y };
    await new Promise(r => setTimeout(r, ms + 60));
    return { x, y };
  };
  window.__click = async (el, ms) => {
    const { x, y } = await window.__point(el, ms);
    const rp = document.createElement('div'); rp.className = '__rip'; rp.style.left = x + 'px'; rp.style.top = y + 'px';
    document.body.appendChild(rp); setTimeout(() => rp.remove(), 700);
    el.click();
    await new Promise(r => setTimeout(r, 150));
  };
  window.__type = async (el, text, cps = 28) => {
    el.focus();
    const set = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
    set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
    for (const ch of text) {
      set.call(el, el.value + ch); el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1000 / cps * (0.6 + Math.random() * 0.8)));
    }
  };
})()`;
const cursor = () => js(CURSOR);
const click = (text, opts = {}) => js(`(async () => { const el = __find(${JSON.stringify(text)}, ${JSON.stringify(opts.sel ?? "button,[role=radio],[role=tab],a,summary,[role=button]")}, ${!!opts.exact});
  if (!el) throw new Error('not found: ' + ${JSON.stringify(text)}); await __click(el, ${opts.ms ?? 700}); return true })()`);
const typeIn = (selector, text, cps) => js(`(async () => { const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('no ' + ${JSON.stringify(selector)}); await __click(el, 600); await __type(el, ${JSON.stringify(text)}, ${cps ?? 28}); return true })()`);
const press = async (key) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : 27 });
};
const waitFor = (expr, ms = 15000) => js(`(async () => { const t0 = Date.now(); while (Date.now() - t0 < ${ms}) { if (${expr}) return true; await new Promise(r => setTimeout(r, 100)); } return false })()`);
const scrollTo = (selector) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.scrollIntoView({ block: 'start' }); return !!el })()`);
const go = async (url) => {
  const loaded = new Promise((r) => on("Page.loadEventFired", r));
  await send("Page.navigate", { url });
  await loaded;
  await sleep(600);
  await cursor();
};

// ------------------------------------------------------------------ recording
let frames = null;
on("Page.screencastFrame", async (p) => {
  if (frames) frames.push({ t: p.metadata.timestamp, data: p.data });
  send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
});
async function record(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  console.log(`clip ${name}…`);
  frames = [];
  await send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W * DSF, maxHeight: H * DSF, everyNthFrame: 1 });
  const started = Date.now() / 1000;
  try { await fn(); } catch (e) { console.log(`  ${name}: ${e.message}`); }
  await send("Page.stopScreencast");
  // Frames still in flight from the previous clip carry older timestamps: drop them.
  const got = frames.filter((f) => f.t >= started - 0.05); frames = null;
  const end = Date.now() / 1000;
  if (!got.length) { console.log("  no frames"); return; }
  // Frames only arrive when the page paints: hold each one until the next, at a constant 30 fps.
  const dir = mkdtempSync(join(tmpdir(), `pg-${name}-`));
  const concat = [];
  got.forEach((f, i) => {
    const file = join(dir, `${String(i).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    const next = i + 1 < got.length ? got[i + 1].t : Math.max(end, f.t + 0.04);
    const from = i === 0 ? Math.max(started, Math.min(f.t, started)) : f.t;
    concat.push(`file '${file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, next - from).toFixed(4)}`);
  });
  concat.push(`file '${join(dir, `${String(got.length - 1).padStart(6, "0")}.jpg`).replace(/\\/g, "/")}'`);
  writeFileSync(join(dir, "list.txt"), concat.join("\n"));
  const out = join(OUT, `${name}.mp4`);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
    "-vf", `fps=${FPS},scale=${W * DSF}:${H * DSF}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "fast", "-crf", "17",
    "-g", "1", "-keyint_min", "1", "-movflags", "+faststart", out], { stdio: "inherit" });
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ${got.length} frames over ${(end - started).toFixed(1)}s (${(got.length / (end - started)).toFixed(1)} fps) -> ${out}${r.status ? " FAILED" : ""}`);
}

// ------------------------------------------------------------------ the clips (state carries over, in this order)
// A view switch, retried until it really shows as selected (a click can land during a re-render).
const radio = async (t) => {
  for (let i = 0; i < 4; i++) {
    await click(t, { sel: "[role=radio]", exact: true, ms: i ? 250 : 700 });
    if (await waitFor(`[...document.querySelectorAll('[role=radio]')].some(r => r.textContent.trim() === ${JSON.stringify(t)} && r.getAttribute('aria-checked') === 'true')`, 1500)) return;
  }
  throw new Error(`view ${t} did not switch`);
};
try {
  await go(APP + "/");
  await js("localStorage.clear(); true");
  await go(APP + "/");
  await waitFor("document.body.innerText.includes('Orders at risk')");

  await record("landing", async () => {
    await sleep(800);
    await js("(async () => { await __point(document.querySelector('h1, .wh-title, [class*=title]') || document.body, 1400); })()");
    await sleep(4500);
  });

  await record("ask", async () => {
    await typeIn("textarea, input[aria-label='Ask a question']", "Which orders are at risk because Singapore closed?", 24);
    await sleep(400);
    await click("Ask", { sel: "button", exact: true, ms: 450 });
    await waitFor("document.querySelector('.stage svg .node')", 15000);
    await sleep(3800);
    await radio("Globe");
    await sleep(6500);
  });

  await record("split", async () => {
    await click("Step by step");
    await sleep(2600);
    await click("8 shipments", { sel: ".trace-pane button, .trace-pane [role=button]" });
    await sleep(3600);
    await click("755 late orders", { sel: ".trace-pane button, .trace-pane [role=button]" });
    await sleep(3600);
    await click("What FalkorDB walked", { sel: ".trace-pane button, .trace-pane [role=button]" });
    await sleep(3000);
  });

  await record("why", async () => {
    await click("Step by step");
    await sleep(300);
    await click("Why is Aisha", { sel: "button" });
    await waitFor("[...document.querySelectorAll('[role=radio]')].some(r => r.textContent.trim() === 'Timeline')", 15000);
    await sleep(2400);
    await radio("Timeline");
    await sleep(7500);
  });

  await record("engines", async () => {
    await radio("Diagram");
    await sleep(600);
    await click("PostgreSQL", { sel: "[role=radio]", exact: false });
    await sleep(2800);
    await click("Compare engines", { sel: "button" });
    await sleep(5200);
    await press("Escape");
    await sleep(500);
    await click("FalkorDB", { sel: "[role=radio]", exact: false });
    await sleep(1200);
  });

  await record("agents", async () => {
    await click("Orders at risk from Singapore", { sel: "button" });
    await sleep(1800);
    await click("Run the agents", { sel: "button" });
    await sleep(1200);
    await waitFor("[...document.querySelectorAll('[role=radio]')].some(r => r.textContent.trim() === 'Agents')", 20000);
    await radio("Agents");
    await sleep(14000);
  });

  await record("approve", async () => {
    await js("document.querySelector('[aria-label=\"Approver name\"]')?.scrollIntoView({ block: 'center' }); true");
    await sleep(500);
    await typeIn("[aria-label='Approver name']", "Kevin Sudhan", 18);
    await click("Approve", { sel: "button", exact: true });
    await sleep(2800);
    await typeIn("[aria-label='Approver name']", "Pranay J Sathish", 18);
    await click("Approve", { sel: "button", exact: true });
    await sleep(5500);
  });

  await record("walk", async () => {
    await radio("Globe");
    await sleep(3000);
    await click("Watch the agents", { sel: "button" });
    await sleep(17000);
  });

  await record("memory", async () => {
    await click("Compare with and without memory", { sel: "button" });
    await sleep(6500);
    await press("Escape");
    await sleep(600);
  });

  await record("bench", async () => {
    await click("Benchmark", { sel: "button", exact: true });
    await waitFor("document.querySelector('[aria-label=\"Memory and benchmark\"] svg')", 20000);
    await sleep(6000);
  });
} finally {
  try { ws.close(); } catch { /* closed */ }
  chrome.kill();
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ } }, 800);
}
