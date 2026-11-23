// Drama Downloader — standalone server (no dependencies, Node 18+)
// Serves the web UI and proxies the public drama resolvers so the browser
// can resolve links, stream downloads with progress, and fetch posters
// without CORS problems.
//
// Combine & Teal & Orange grade need ffmpeg + ffprobe installed on the
// host at runtime (see README-DEPLOY.md). Resolve and plain downloads
// keep working even if ffmpeg is missing.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync, execFile } = require("child_process");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// ---- ffmpeg availability (checked once at startup) ----
let FFMPEG_OK = false;
try {
  const r = spawnSync("ffmpeg", ["-version"], { timeout: 5000 });
  FFMPEG_OK = r.status === 0;
} catch {
  FFMPEG_OK = false;
}
try {
  const r2 = spawnSync("ffprobe", ["-version"], { timeout: 5000 });
  if (r2.status !== 0) FFMPEG_OK = false;
} catch {
  FFMPEG_OK = false;
}

// ---- Owner settings (edited from the /admin page, no code needed) ----
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";
const DEFAULT_SETTINGS = {
  appName: "DramaSave",
  tagline: "PINEDRAMA + TIKTOK RESOLVER",
  heading: "Download short dramas in highest quality",
  subtext:
    "Paste a PineDrama or TikTok drama link (or a series link), resolve it, then save each episode as MP4 — named “Title Ep 01”, “Title Ep 02”, and so on. For personal offline viewing only.",
  footer: "Only save videos you are allowed to keep for personal offline viewing. Do not redistribute other people's content.",
  contactEmail: "digitalemporia0@gmail.com",
  pink: "#ff2e88",
  pink2: "#ff6aa9",
  defaultTheme: "dark", // "dark" | "bright"
  logoUrl: "", // set after uploading a logo in /admin
  showThumbnailButton: true,
  showFullSeriesButton: true,
  showBatchButtons: true,
};
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 6 * 1024 * 1024) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Public resolver backends used by dramasave-style tools. Their responses
// vary, so the normalizer below digs tolerantly for titles/episodes/streams.
const RESOLVERS = [
  (u) => "https://pinedrama-downloader.com/api/resolve?url=" + encodeURIComponent(u),
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      ...(opts.headers || {}),
    },
    ...opts,
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Recursively collect every object that looks like an episode/stream entry.
function collectCandidates(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectCandidates(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const urlFields = ["url", "downloadUrl", "download_url", "playUrl", "play_url", "streamUrl", "videoUrl", "proxyUrl", "directUrl", "deliveryUrl", "href"];
    const hasStream = urlFields.some(
      (f) => typeof node[f] === "string" && /^https?:\/\//.test(node[f]) && (/\.mp4(\?|$)/i.test(node[f]) || /video|play|stream|download/i.test(node[f]))
    );
    const variants = node.variants || node.qualities || node.streams || node.formats;
    if (hasStream || Array.isArray(variants)) out.push(node);
    for (const v of Object.values(node)) collectCandidates(v, out, depth + 1);
  }
}

function pickString(obj, fields) {
  for (const f of fields) {
    if (typeof obj[f] === "string" && obj[f].trim()) return obj[f];
  }
  return "";
}

function normalizeEpisode(raw, idx) {
  const variants = raw.variants || raw.qualities || raw.streams || raw.formats || [];
  let stream = "";
  let bestScore = -1;
  const scoreOf = (label) => {
    const s = String(label || "").toLowerCase();
    let sc = 0;
    const m = s.match(/(\d{3,4})\s*p/);
    if (m) sc = parseInt(m[1], 10);
    if (s.includes("fhd") || s.includes("1080")) sc = Math.max(sc, 1080);
    if (s.includes("hd")) sc = Math.max(sc, 720);
    return sc;
  };
  if (Array.isArray(variants)) {
    for (const v of variants) {
      if (!v || typeof v !== "object") continue;
      const u = pickString(v, ["url", "downloadUrl", "playUrl", "streamUrl", "proxyUrl", "directUrl", "href"]);
      if (!u) continue;
      const sc = scoreOf(v.quality || v.label || v.name || v.resolution);
      if (sc > bestScore) {
        bestScore = sc;
        stream = u;
      }
    }
  }
  if (!stream) {
    stream = pickString(raw, ["downloadUrl", "playUrl", "streamUrl", "videoUrl", "proxyUrl", "directUrl", "deliveryUrl", "url"]);
  }
  const n =
    Number(raw.episode ?? raw.episodeNumber ?? raw.ep ?? raw.number ?? raw.index ?? idx + 1) || idx + 1;
  return {
    n,
    duration: raw.duration || raw.durationText || raw.length || "",
    thumb: pickString(raw, ["thumbnail", "thumbnailUrl", "poster", "posterUrl", "cover", "coverUrl", "image", "imageUrl"]),
    stream,
  };
}

function normalizeResult(data, sourceUrl) {
  if (!data) return null;
  const root = data.data && typeof data.data === "object" ? data.data : data;
  const title =
    pickString(root, ["title", "name", "dramaTitle", "seriesTitle"]) ||
    pickString(data, ["title", "name"]) ||
    "Drama";
  const poster = pickString(root, ["poster", "posterUrl", "cover", "coverUrl", "thumbnail", "image"]);
  const candidates = [];
  collectCandidates(data, candidates);
  const seen = new Set();
  const episodes = [];
  for (const c of candidates) {
    const ep = normalizeEpisode(c, episodes.length);
    if (!ep.stream || seen.has(ep.stream)) continue;
    seen.add(ep.stream);
    episodes.push(ep);
  }
  episodes.sort((a, b) => a.n - b.n);
  if (!episodes.length) return null;
  episodes.forEach((e, i) => {
    if (!e.thumb) e.thumb = poster;
    if (!e.n) e.n = i + 1;
  });
  return { title, poster, episodes, source: sourceUrl };
}

async function handleResolve(req, res, query) {
  const link = (query.get("url") || "").trim();
  if (!link || !/^https?:\/\//i.test(link)) {
    return sendJson(res, 400, { error: "Paste a valid PineDrama or TikTok link first." });
  }
  let lastErr = null;
  for (const make of RESOLVERS) {
    const apiUrl = make(link);
    // The resolver endpoint now requires POST (GET answers 405 "Use POST
    // for this endpoint"), so try POST first and fall back to GET.
    for (const attempt of ["POST", "GET"]) {
      try {
        let data;
        if (attempt === "POST") {
          data = await fetchJson(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: link }),
          });
        } else {
          data = await fetchJson(apiUrl);
        }
        const normalized = normalizeResult(data, link);
        if (normalized) return sendJson(res, 200, normalized);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  return sendJson(res, 502, {
    error:
      "Could not resolve this link. It may be private, paid, region-locked, or the resolver service is busy. Try the full link copied from the app.",
    detail: lastErr ? String(lastErr).slice(0, 200) : undefined,
  });
}

async function proxyStream(req, res, query, forcedType) {
  const target = query.get("url") || "";
  const name = (query.get("name") || "download").replace(/[\/\\:*?"<>|]/g, "").slice(0, 180);
  if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { error: "Bad url" });
  try {
    const up = await fetch(target, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        Referer: "https://www.tiktok.com/",
      },
    });
    if (!up.ok || !up.body) return sendJson(res, 502, { error: "Source returned " + up.status });
    const type = forcedType || up.headers.get("content-type") || "application/octet-stream";
    const len = up.headers.get("content-length");
    const headers = {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${name}"`,
    };
    if (len) headers["Content-Length"] = len;
    res.writeHead(200, headers);
    const reader = up.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { error: String(e).slice(0, 200) });
    else res.end();
  }
}

// =====================================================================
// Combine + Teal & Orange grade (needs ffmpeg + ffprobe on the host)
// =====================================================================

const JOBS_DIR = path.join(__dirname, "jobs");
const MAX_COMBINE_BYTES = 300 * 1024 * 1024; // 300 MB total per combine
const JOB_TTL_MS = 60 * 60 * 1000; // finished files kept 1 hour, then deleted
const GRADES = {
  // colorbalance: shadows -> teal/cyan (less red, more green+blue),
  // highlights -> warm orange (more red, less blue); eq adds a little
  // saturation and contrast so faces stay forward, like a Hollywood grade.
  subtle:
    "colorbalance=rs=-0.04:gs=0.03:bs=0.06:rm=-0.015:gm=0.01:bm=0.025:rh=0.05:gh=0.015:bh=-0.04,eq=saturation=1.06:contrast=1.02",
  classic:
    "colorbalance=rs=-0.08:gs=0.06:bs=0.12:rm=-0.03:gm=0.02:bm=0.05:rh=0.10:gh=0.03:bh=-0.08,eq=saturation=1.12:contrast=1.05",
  strong:
    "colorbalance=rs=-0.12:gs=0.09:bs=0.18:rm=-0.05:gm=0.035:bm=0.08:rh=0.15:gh=0.05:bh=-0.12,eq=saturation=1.20:contrast=1.08",
};
const GRADE_NAMES = ["off", "subtle", "classic", "strong"];

function pad2(n) {
  return String(n).padStart(2, "0");
}
function cleanName(s) {
  return String(s || "Drama")
    .replace(/[\/\\:*?"<>|#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "Drama";
}

// --- job store: one ffmpeg job runs at a time, the rest queue ---
const jobs = new Map();
let ffmpegBusy = false;
const pendingJobs = [];

function newJob(kind, filename) {
  const id = crypto.randomBytes(8).toString("hex");
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id, kind, status: "queued", pct: 0, stage: "Queued…", error: null,
    filename, dir, file: null, size: 0, createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}
function scheduleCleanup(job) {
  setTimeout(() => {
    try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
    jobs.delete(job.id);
  }, JOB_TTL_MS);
}
function enqueue(job, fn) {
  job.run = fn;
  pendingJobs.push(job);
  pumpQueue();
}
function pumpQueue() {
  if (ffmpegBusy) return;
  const job = pendingJobs.shift();
  if (!job) return;
  ffmpegBusy = true;
  (async () => {
    try {
      job.status = "working";
      await job.run(job);
      if (job.status !== "error") {
        job.status = "ready";
        job.pct = 100;
        job.stage = "Ready";
      }
    } catch (e) {
      job.status = "error";
      job.error = String(e.message || e).slice(0, 300);
      job.stage = "Failed";
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
    } finally {
      ffmpegBusy = false;
      scheduleCleanup(job);
      pumpQueue();
    }
  })();
}

// Download a stream URL to a file. Returns bytes written. Throws on HTTP
// error or if the file alone exceeds maxBytes.
//
// NOTE: this deliberately uses the built-in http/https modules, NOT fetch.
// Node 24's fetch (undici) crashes the whole server with an assertion
// (assert(!this.paused) in Parser.finish) when a download's socket closes
// while reads are paused for write backpressure — which is exactly what
// happens at the end of a file served by a plain HTTP/1.0 static server.
// The classic http.get + res.pipe(ws) pattern has no such bug.
const httpMod = require("http");
const httpsMod = require("https");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

function downloadToFile(url, dest, maxBytes, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? httpsMod : httpMod;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    };
    const req = lib.get(
      url,
      { headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/" } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirects >= 5) return fail(new Error("Too many redirects."));
          res.resume();
          return downloadToFile(new URL(res.headers.location, url).toString(), dest, maxBytes, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error("Source returned " + res.statusCode));
        }
        const ws = fs.createWriteStream(dest);
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            res.destroy();
            ws.destroy();
            fail(new Error("File is larger than the 300 MB limit."));
          }
        });
        res.on("error", (e) => fail(new Error("Download failed: " + String(e).slice(0, 150))));
        ws.on("error", (e) => fail(new Error("Write failed: " + String(e).slice(0, 150))));
        ws.on("finish", () => {
          if (!settled) {
            settled = true;
            resolve(bytes);
          }
        });
        res.pipe(ws);
      }
    );
    req.on("error", (e) => fail(new Error("Download failed: " + String(e).slice(0, 150))));
    req.setTimeout(180000, () => req.destroy(new Error("Download timed out.")));
  });
}

function probeFile(file) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error("Could not read the video file (ffprobe failed)."));
        try {
          const j = JSON.parse(stdout);
          const v = (j.streams || []).find((s) => s.codec_type === "video");
          const a = (j.streams || []).find((s) => s.codec_type === "audio");
          resolve({
            width: v ? v.width || 0 : 0,
            height: v ? v.height || 0 : 0,
            duration:
              parseFloat((v && v.duration) || (j.format && j.format.duration) || 0) || 0,
            vcodec: v ? v.codec_name || "" : "",
            hasAudio: !!a,
            streamCount: (j.streams || []).length,
          });
        } catch {
          reject(new Error("Could not read the video file."));
        }
      }
    );
  });
}

// Run ffmpeg, updating job.pct from its progress output. fromPct/toPct map
// the encode phase onto part of the overall bar (fetching is the rest).
function runFfmpeg(args, job, totalDuration, fromPct, toPct) {
  return new Promise((resolve, reject) => {
    const fullArgs = ["-y", "-progress", "pipe:1", "-nostats", ...args];
    const child = spawn("ffmpeg", fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let errText = "";
    let settled = false;
    child.stdout.on("data", (d) => {
      if (!totalDuration) return;
      const m = /out_time_ms=(\d+)/.exec(d.toString());
      if (m) {
        const t = parseInt(m[1], 10) / 1e6;
        const pct = fromPct + Math.min(1, t / totalDuration) * (toPct - fromPct);
        job.pct = Math.min(toPct - 1, Math.floor(pct));
      }
    });
    child.stderr.on("data", (d) => {
      errText += d.toString();
      if (errText.length > 4000) errText = errText.slice(-4000);
    });
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(new Error("ffmpeg could not start: " + String(e.message || e).slice(0, 150)));
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else {
        const tail = errText.replace(/\s+/g, " ").trim().slice(-300);
        reject(new Error("Video processing failed" + (tail ? ": " + tail : "")));
      }
    });
  });
}

async function runCombine(job, { title, episodes, grade }) {
  job.stage = "Fetching episodes…";
  job.pct = 1;
  let total = 0;
  const parts = [];
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const dest = path.join(job.dir, "ep" + pad2(ep.n) + ".mp4");
    const size = await downloadToFile(ep.stream, dest, MAX_COMBINE_BYTES);
    total += size;
    if (total > MAX_COMBINE_BYTES) {
      throw new Error("Selected episodes total over 300 MB. Pick fewer episodes.");
    }
    const p = await probeFile(dest);
    if (!p.width || !p.duration) throw new Error("Episode " + ep.n + " could not be read.");
    parts.push({ file: dest, n: ep.n, size, ...p });
    job.pct = Math.round(((i + 1) / episodes.length) * 20);
  }
  let minPart = parts[0];
  for (const p of parts) {
    if (p.width * p.height > 0 && p.width * p.height < minPart.width * minPart.height) minPart = p;
  }
  const sameRes = parts.every((p) => p.width === parts[0].width && p.height === parts[0].height);
  const totalDur = parts.reduce((s, p) => s + p.duration, 0);
  const listPath = path.join(job.dir, "list.txt");
  fs.writeFileSync(
    listPath,
    parts.map((p) => "file '" + p.file.replace(/'/g, "'\\''") + "'").join("\n")
  );
  const outPath = path.join(job.dir, "combined.mp4");
  job.stage = grade !== "off" ? "Grading & joining…" : "Joining episodes…";
  if (grade === "off" && sameRes) {
    // Fast path: identical episodes join without re-encoding.
    try {
      await runFfmpeg(
        ["-f", "concat", "-safe", "0", "-i", listPath, "-map", "0", "-c", "copy", "-movflags", "+faststart", outPath],
        job, totalDur, 20, 95
      );
    } catch {
      // Stream-copy join failed (codec mismatch) — re-encode cleanly instead.
      await runFfmpeg(
        ["-f", "concat", "-safe", "0", "-i", listPath, "-vf", "scale=" + parts[0].width + ":" + parts[0].height,
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath],
        job, totalDur, 20, 95
      );
    }
  } else {
    // Graded, or mixed resolutions: one re-encode. Mixed resolutions are
    // scaled down to the lowest episode's resolution so the file is a
    // single valid track (this is why the panel says quality follows the
    // lowest episode).
    const vf = [];
    if (!sameRes) vf.push("scale=" + minPart.width + ":" + minPart.height);
    if (grade !== "off") vf.push(GRADES[grade]);
    await runFfmpeg(
      ["-f", "concat", "-safe", "0", "-i", listPath, "-vf", vf.join(","),
       "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath],
      job, totalDur, 20, 95
    );
  }
  const st = fs.statSync(outPath);
  if (!st.size) throw new Error("The combined file came out empty.");
  job.file = outPath;
  job.size = st.size;
}

async function runGrade(job, { stream, grade }) {
  job.stage = "Fetching episode…";
  job.pct = 2;
  const dest = path.join(job.dir, "source.mp4");
  await downloadToFile(stream, dest, MAX_COMBINE_BYTES);
  const p = await probeFile(dest);
  if (!p.width || !p.duration) throw new Error("This episode could not be read.");
  job.stage = "Grading (Teal & Orange)…";
  const outPath = path.join(job.dir, "graded.mp4");
  await runFfmpeg(
    ["-i", dest, "-vf", GRADES[grade],
     "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath],
    job, p.duration, 10, 95
  );
  const st = fs.statSync(outPath);
  if (!st.size) throw new Error("The graded file came out empty.");
  job.file = outPath;
  job.size = st.size;
}

function ffmpegMissing(res) {
  return sendJson(res, 503, {
    error:
      "This server does not have ffmpeg installed, so Combine and Teal & Orange grading are unavailable here. On Render, deploy with the included Dockerfile (see README-DEPLOY.md). Plain downloads still work.",
  });
}

async function handleCombine(req, res) {
  if (!FFMPEG_OK) return ffmpegMissing(res);
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }
  const eps = Array.isArray(body.episodes) ? body.episodes : [];
  if (eps.length < 2 || eps.length > 10) {
    return sendJson(res, 400, { error: "Pick 2 to 10 episodes to combine." });
  }
  if (!eps.every((e) => e && /^https?:\/\//i.test(e.stream || "") && Number(e.n) > 0)) {
    return sendJson(res, 400, { error: "One of the selected episodes has no video link." });
  }
  const grade = GRADE_NAMES.includes(body.grade) ? body.grade : "off";
  const title = cleanName(body.title);
  const nums = eps.map((e) => Number(e.n));
  const filename =
    title + " Ep " + pad2(Math.min(...nums)) + "-" + pad2(Math.max(...nums)) + " Combined" +
    (grade !== "off" ? " (Teal & Orange)" : "") + ".mp4";
  const job = newJob("combine", filename);
  enqueue(job, (j) => runCombine(j, { title, episodes: eps, grade }));
  return sendJson(res, 200, { jobId: job.id });
}

async function handleGrade(req, res) {
  if (!FFMPEG_OK) return ffmpegMissing(res);
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }
  if (!/^https?:\/\//i.test(body.stream || "")) {
    return sendJson(res, 400, { error: "No video link for this episode." });
  }
  const grade = GRADE_NAMES.includes(body.grade) && body.grade !== "off" ? body.grade : null;
  if (!grade) return sendJson(res, 400, { error: "Pick a grade (Subtle, Classic or Strong)." });
  const base = cleanName(String(body.name || "Episode").replace(/\.mp4$/i, ""));
  const filename = base + " (Teal & Orange).mp4";
  const job = newJob("grade", filename);
  enqueue(job, (j) => runGrade(j, { stream: body.stream, grade }));
  return sendJson(res, 200, { jobId: job.id });
}

function handleJob(req, res, query) {
  const id = query.get("id") || "";
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { error: "Job not found or expired." });
  return sendJson(res, 200, {
    id: job.id, kind: job.kind, status: job.status, pct: job.pct,
    stage: job.stage, error: job.error, filename: job.filename,
    size: job.size, downloadUrl: job.status === "ready" ? "/api/file?id=" + job.id : null,
  });
}

function handleFile(req, res, query) {
  const id = query.get("id") || "";
  const job = jobs.get(id);
  if (!job || job.status !== "ready" || !job.file || !fs.existsSync(job.file)) {
    return sendJson(res, 404, { error: "File not ready or expired (files are kept for 1 hour)." });
  }
  const st = fs.statSync(job.file);
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": st.size,
    "Content-Disposition":
      'attachment; filename="' + job.filename.replace(/["\\]/g, "") + '"; filename*=UTF-8\'\'' +
      encodeURIComponent(job.filename),
  });
  fs.createReadStream(job.file).pipe(res);
}

// Clear any leftover job files from a previous run.
try { fs.rmSync(JOBS_DIR, { recursive: true, force: true }); } catch {}
try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch {}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  try {
    if (p === "/api/resolve") return await handleResolve(req, res, u.searchParams);
    if (p === "/api/download") return await proxyStream(req, res, u.searchParams, "video/mp4");
    if (p === "/api/thumb") return await proxyStream(req, res, u.searchParams, null);
    if (p === "/api/combine" && req.method === "POST") return await handleCombine(req, res);
    if (p === "/api/grade" && req.method === "POST") return await handleGrade(req, res);
    if (p === "/api/job") return handleJob(req, res, u.searchParams);
    if (p === "/api/file") return handleFile(req, res, u.searchParams);
    if (p === "/api/settings" && req.method === "GET") return sendJson(res, 200, loadSettings());
    if (p === "/api/admin/settings" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (body.password !== ADMIN_PASSWORD) return sendJson(res, 401, { error: "Wrong admin password." });
      const cur = loadSettings();
      const next = { ...cur };
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (k === "logoUrl") continue;
        if (body.settings && k in body.settings) next[k] = body.settings[k];
      }
      saveSettings(next);
      return sendJson(res, 200, next);
    }
    if (p === "/api/admin/logo" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (body.password !== ADMIN_PASSWORD) return sendJson(res, 401, { error: "Wrong admin password." });
      const m = /^data:image\/(png|jpeg|webp|svg\+xml);base64,(.+)$/.exec(body.dataUrl || "");
      if (!m) return sendJson(res, 400, { error: "Upload a PNG, JPG, WEBP or SVG image." });
      const ext = m[1] === "jpeg" ? "jpg" : m[1] === "svg+xml" ? "svg" : m[1];
      fs.writeFileSync(path.join(PUBLIC_DIR, "logo." + ext), Buffer.from(m[2], "base64"));
      const cur = loadSettings();
      cur.logoUrl = "/logo." + ext;
      saveSettings(cur);
      return sendJson(res, 200, { logoUrl: cur.logoUrl });
    }
    // static
    let file = p === "/" ? "/index.html" : p === "/admin" ? "/admin.html" : p;
    const full = path.join(PUBLIC_DIR, path.normalize(file));
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e).slice(0, 200) });
  }
});

server.listen(PORT, () =>
  console.log("Drama Downloader running on port " + PORT + " (ffmpeg: " + (FFMPEG_OK ? "available" : "NOT installed — Combine & grading disabled") + ")")
);
