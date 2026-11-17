#!/usr/bin/env node
// Render docs/demo-source.html to docs/demo.gif (+ docs/demo.mp4).
//
//   node tools/render-demo.mjs
//
// Dependency-free: drives the Chrome you already have over the DevTools protocol
// (Node's built-in WebSocket), then encodes with ffmpeg. The page is a pure
// function of time — window.seek(t) — so each frame is just one screenshot.
//
// Options (all optional):
//   --html=docs/demo-source.html  --out=docs/demo.gif  --fps=15
//   --width=960 --height=750 --scale=2 --gifwidth=900 [--frames=DIR] [--mp4]
//   CHROME=/path/to/chrome  (default: google-chrome, then chromium)

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const opts = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [[m[1], m[2]]] : [];
  })
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = path.resolve(ROOT, opts.html || "docs/demo-source.html");
const GIF = path.resolve(ROOT, opts.out || "docs/demo.gif");
const MP4 = GIF.replace(/\.gif$/, ".mp4");
const FPS = Number(opts.fps || 15);
const W = Number(opts.width || 960);
const H = Number(opts.height || 750);
const SCALE = Number(opts.scale || 2);
const GIF_W = Number(opts.gifwidth || 900);
const PORT = 9333;
const CHROME = process.env.CHROME || "google-chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome keeps writing to its profile for a moment after SIGTERM, so a plain
// rm can fail with ENOTEMPTY; retry a few times instead of failing the render.
async function rmWhenQuiet(dir, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(150);
    }
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("Chrome did not open a DevTools endpoint");
}

// --- minimal CDP client: request/response over one browser socket -------------
function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("DevTools socket failed"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = msg.id && pending.get(msg.id);
    if (!slot) return; // events (e.g. loadEventFired) are not used here
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ready, send, close: () => ws.close() };
}

const framesDir = opts.frames ? path.resolve(ROOT, opts.frames) : await mkdtemp(path.join(tmpdir(), "sarva-demo-"));
const profileDir = await mkdtemp(path.join(tmpdir(), "sarva-chrome-"));
await mkdir(framesDir, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--window-size=${W},${H}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
chrome.on("error", (e) => {
  console.error(`Could not start ${CHROME}: ${e.message}`);
  process.exit(1);
});

let cdp;
try {
  const wsUrl = await waitForDevtools();
  cdp = cdpClient(wsUrl);
  await cdp.ready;

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => cdp.send(method, params, sessionId);

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: W, height: H, deviceScaleFactor: SCALE, mobile: false,
  });
  await call("Page.navigate", { url: pathToFileURL(HTML).href });

  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression} threw: ${r.exceptionDetails.text}`);
    return r.result.value;
  };

  // the page defines window.seek(t) once its scripts have run
  for (let i = 0; i < 150; i++) {
    if ((await evaluate("typeof seek")) === "function") break;
    await sleep(100);
  }
  const end = Number(await evaluate("T.end"));
  if (!Number.isFinite(end) || end <= 0) throw new Error("could not read T.end from the page");

  const total = Math.round(end * FPS);
  console.log(`rendering ${total} frames (${end}s @ ${FPS}fps, ${W}x${H} x${SCALE}) from ${path.relative(ROOT, HTML)}`);

  for (let i = 0; i < total; i++) {
    await evaluate(`seek(${(i / FPS).toFixed(4)})`);
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(framesDir, `f${String(i).padStart(4, "0")}.png`), Buffer.from(data, "base64"));
    if (i % 60 === 0 || i === total - 1) process.stdout.write(`\r  frame ${i + 1}/${total}`);
  }
  process.stdout.write("\n");
} finally {
  cdp?.close();
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  await rmWhenQuiet(profileDir);
}

const input = ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(framesDir, "f%04d.png")];
const scale = `scale=${GIF_W}:-2:flags=lanczos`;

console.log("encoding", path.relative(ROOT, GIF));
await run("ffmpeg", [
  ...input,
  "-vf", `${scale},split=2[p0][p1];[p0]palettegen=max_colors=128:stats_mode=diff[p];[p1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  "-loop", "0", GIF,
]);
if (opts.mp4) {
  // a README can only autoplay the GIF; the MP4 is for a release page or a post
  await run("ffmpeg", [
    ...input, "-vf", scale, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", MP4,
  ]);
}

if (!opts.frames) await rmWhenQuiet(framesDir);
console.log(`wrote ${path.relative(ROOT, GIF)}${opts.mp4 ? " and " + path.relative(ROOT, MP4) : ""}`);
