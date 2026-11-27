'use strict';
// Local helper for the Stremio Clipper plugin. Binds to 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

const PORT = parseInt(process.env.CLIPPER_PORT || '47811', 10);
const CLIPS_DIR = path.resolve(__dirname, '..', 'stremio clips');
const ALLOWED_ORIGINS = new Set(['https://web.stremio.com', 'https://app.strem.io', 'http://127.0.0.1:11470']);
(process.env.CLIPPER_EXTRA_ORIGINS || '').split(',').filter(Boolean).forEach((o) => ALLOWED_ORIGINS.add(o));
fs.mkdirSync(CLIPS_DIR, { recursive: true });

const jobs = new Map();

function sanitize(name) {
  let s = String(name || 'clip').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!s) s = 'clip';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s.slice(0, 100);
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '.' + p(d.getMinutes()) + '.' + p(d.getSeconds());
}

function uniquePath(base) {
  let f = path.join(CLIPS_DIR, base + '.mp4'), n = 2;
  while (fs.existsSync(f)) f = path.join(CLIPS_DIR, base + ' (' + n++ + ').mp4');
  return f;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 5e6) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function validUrl(u) {
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch (_) { return false; }
}

// Debrid links (e.g. torrentio -> TorBox requestdl -> CDN) redirect, and the redirect endpoint is rate-limited.
// ffmpeg re-opens the source for every thumbnail/frame/preview, so resolve the chain once and reuse the final URL.
const RESOLVE_TTL = 15 * 60 * 1000;
const resolveCache = new Map();
function hop(u) {
  return new Promise((resolve) => {
    let lib; try { lib = new URL(u).protocol === 'https:' ? require('https') : http; } catch (_) { return resolve({ error: true }); }
    const r = lib.get(u, { headers: { Range: 'bytes=0-0' }, timeout: 20000 }, (x) => {
      x.resume();
      resolve({ status: x.statusCode, loc: x.headers.location, retryAfter: parseInt(x.headers['retry-after'], 10) || 0 });
    });
    r.on('error', () => resolve({ error: true }));
    r.on('timeout', () => { r.destroy(); resolve({ error: true }); });
  });
}
async function followRedirects(u) {
  let cur = u;
  for (let n = 0, waited = 0; n < 8; n++) {
    const r = await hop(cur);
    if (r.error) return cur;
    if (r.status >= 300 && r.status < 400 && r.loc) { cur = new URL(r.loc, cur).toString(); continue; }
    if (r.status === 429 && r.retryAfter && waited + r.retryAfter <= 70) { waited += r.retryAfter; await new Promise((z) => setTimeout(z, (r.retryAfter + 1) * 1000)); n--; continue; }
    return cur;
  }
  return cur;
}
function resolveSrc(u) {
  const hit = resolveCache.get(u);
  if (hit && Date.now() - hit.at < RESOLVE_TTL) return hit.p;
  const p = followRedirects(u).catch(() => u);
  resolveCache.set(u, { p, at: Date.now() });
  if (resolveCache.size > 50) resolveCache.delete(resolveCache.keys().next().value);
  return p;
}

function inClips(f) {
  const r = path.resolve(f);
  return r.startsWith(CLIPS_DIR + path.sep) && fs.existsSync(r);
}

// ---- work pool (exact frames before filmstrip thumbnails), caches, timing log ----
const POOL_MAX = 4;
let poolActive = 0;
const poolQ = [];
function schedule(prio, signal, fn) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const job = { prio, fn, resolve, reject };
    if (signal) signal.addEventListener('abort', () => { const i = poolQ.indexOf(job); if (i >= 0) { poolQ.splice(i, 1); reject(new Error('aborted')); } }, { once: true });
    poolQ.push(job);
    poolQ.sort((a, b) => a.prio - b.prio);
    pumpPool();
  });
}
function pumpPool() {
  while (poolActive < POOL_MAX && poolQ.length) {
    const j = poolQ.shift();
    poolActive++;
    Promise.resolve().then(j.fn).then(j.resolve, j.reject).finally(() => { poolActive--; pumpPool(); });
  }
}
const perf = [];
function note(kind, ms) { perf.push({ kind, ms: Math.round(ms) }); if (perf.length > 40) perf.shift(); }
function lru(map, key, val, max) { map.set(key, val); if (map.size > max) map.delete(map.keys().next().value); }
function clampN(v, a, b, d) { v = Number(v); if (!isFinite(v)) v = d; return Math.min(Math.max(v, a), b); }
const THUMB_CACHE = new Map(), FRAME_CACHE = new Map();
async function getThumb(src, t, h, signal) {
  const key = src + '|' + t.toFixed(2) + '|' + h;
  const hit = THUMB_CACHE.get(key);
  if (hit) return hit;
  const buf = await schedule(1, signal, async () => {
    const t0 = Date.now();
    const b = await ff.grab(src, t, { height: h, keyOnly: true, q: 6, signal });
    note('thumb', Date.now() - t0);
    return b;
  });
  lru(THUMB_CACHE, key, buf, 600);
  return buf;
}
async function getFrame(src, t, h, fast, signal) {
  const base = src + '|' + t.toFixed(2) + '|' + h + '|';
  const hit = FRAME_CACHE.get(base + 'x') || (fast && FRAME_CACHE.get(base + 'f'));
  if (hit) return hit;
  const buf = await schedule(0, signal, async () => {
    const t0 = Date.now();
    const b = await ff.grab(src, t, { height: h, fast, q: 3, signal });
    note(fast ? 'frame-fast' : 'frame-exact', Date.now() - t0);
    return b;
  });
  lru(FRAME_CACHE, base + (fast ? 'f' : 'x'), buf, 80);
  return buf;
}

// ---- preview proxies: small 720p encodes of the trimmed range, played by the plugin ----
const PREVIEW_DIR = path.join(os.tmpdir(), 'stremio-clipper-preview');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });
try { for (const f of fs.readdirSync(PREVIEW_DIR)) fs.unlinkSync(path.join(PREVIEW_DIR, f)); } catch (_) {}
const previews = new Map();
function dropPreview(job) {
  if (job.proc && job.status === 'running') { job.cancelled = true; try { job.proc.kill(); } catch (_) {} }
  try { fs.unlinkSync(job.file); } catch (_) {}
  previews.delete(job.id);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'origin not allowed' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, ffmpeg: !!ff.tools, encoder: ff.getEncoder(), clipsDir: CLIPS_DIR, perf });
    }
    if (req.method === 'POST' && url.pathname === '/probe') {
      const { url: src } = await readBody(req);
      if (!validUrl(src)) return send(res, 400, { error: 'bad url' });
      try { return send(res, 200, await ff.probe(await resolveSrc(src))); }
      catch (e) { return send(res, 500, { error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && (url.pathname === '/thumb' || url.pathname === '/frame')) {
      const isFrame = url.pathname === '/frame';
      const b = await readBody(req);
      if (!validUrl(b.url)) return send(res, 400, { error: 'bad url' });
      const t = Number(b.t);
      if (!(t >= 0)) return send(res, 400, { error: 'bad time' });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      try {
        const buf = isFrame
          ? await getFrame(await resolveSrc(b.url), t, clampN(b.h, 144, 1080, 720), !!b.fast, ac.signal)
          : await getThumb(await resolveSrc(b.url), t, clampN(b.h, 24, 360, 72), ac.signal);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=600' });
        return res.end(buf);
      } catch (e) {
        if (ac.signal.aborted) return;
        return send(res, 500, { error: String(e.message || e) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/preview') {
      const b = await readBody(req);
      if (!validUrl(b.url)) return send(res, 400, { error: 'bad url' });
      const start = Number(b.start), end = Number(b.end);
      if (!(start >= 0) || !(end > start) || end - start > 900) return send(res, 400, { error: 'bad range' });
      for (const j of Array.from(previews.values())) if (j.status === 'running' || Date.now() - j.created > 30 * 60 * 1000) dropPreview(j);
      const id = crypto.randomBytes(6).toString('hex');
      const outFile = path.join(PREVIEW_DIR, id + '.mp4');
      const job = { id, status: 'running', progress: 0, file: outFile, notes: [], created: Date.now() };
      previews.set(id, job);
      const t0 = Date.now();
      ff.encodeClip({
        url: await resolveSrc(b.url), start, end, height: clampN(b.height, 240, 1080, 720), fps: 0, srcFps: 0,
        videoKbps: clampN(b.videoKbps, 400, 8000, 3000), audioIndex: clampN(b.audioIndex, 0, 32, 0), subtitle: null, outFile
      }, job).then(() => {
        job.status = 'done'; job.progress = 1;
        note('preview(' + Math.round(end - start) + 's)', Date.now() - t0);
      }).catch((e) => {
        job.status = job.cancelled ? 'cancelled' : 'error'; job.error = String(e.message || e);
        try { fs.unlinkSync(outFile); } catch (_) {}
      });
      return send(res, 200, { id });
    }
    {
      const pm = /^\/preview\/([a-f0-9]+)(?:\/(file|cancel))?$/.exec(url.pathname);
      if (pm) {
        const job = previews.get(pm[1]);
        if (pm[2] === 'cancel' && req.method === 'POST') { if (job) dropPreview(job); return send(res, 200, { ok: true }); }
        if (!job) return send(res, 404, { error: 'unknown preview' });
        if (pm[2] === 'file') {
          if (job.status !== 'done' || !fs.existsSync(job.file)) return send(res, 409, { error: 'not ready' });
          const size = fs.statSync(job.file).size;
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
          return fs.createReadStream(job.file).pipe(res);
        }
        return send(res, 200, { id: job.id, status: job.status, progress: job.progress, error: job.error });
      }
    }
    if (req.method === 'POST' && url.pathname === '/clip') {
      const b = await readBody(req);
      if (!validUrl(b.url)) return send(res, 400, { error: 'bad url' });
      const start = Number(b.start), end = Number(b.end);
      if (!(start >= 0) || !(end > start)) return send(res, 400, { error: 'bad range' });
      if (b.subtitle && b.subtitle.type === 'external' && !validUrl(b.subtitle.url)) return send(res, 400, { error: 'bad subtitle url' });
      const id = crypto.randomBytes(6).toString('hex');
      const outFile = uniquePath(sanitize(b.title) + (b.stamp === false ? '' : ' ' + stamp()));
      const job = { id, status: 'running', progress: 0, file: outFile, notes: [] };
      jobs.set(id, job);
      ff.encodeClip({
        url: await resolveSrc(b.url), start, end, height: Number(b.height) || 720, fps: Number(b.fps) || 0, srcFps: Number(b.srcFps) || 0,
        videoKbps: Number(b.videoKbps) || 2000, audioIndex: Number(b.audioIndex) || 0, subtitle: b.subtitle || null, outFile
      }, job).then((r) => {
        job.status = 'done'; job.progress = 1; job.notes = r.notes; job.encoder = r.encoder;
        try { job.size = fs.statSync(outFile).size; } catch (_) {}
      }).catch((e) => {
        job.status = job.cancelled ? 'cancelled' : 'error'; job.error = String(e.message || e);
        try { fs.unlinkSync(outFile); } catch (_) {}
      });
      return send(res, 200, { id });
    }
    let m = /^\/clip\/([a-f0-9]+)(\/cancel)?$/.exec(url.pathname);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'unknown job' });
      if (m[2] && req.method === 'POST') { job.cancelled = true; if (job.proc) job.proc.kill(); return send(res, 200, { ok: true }); }
      return send(res, 200, { id: job.id, status: job.status, progress: job.progress, file: job.file, name: path.basename(job.file), size: job.size, error: job.error, notes: job.notes });
    }
    if (req.method === 'POST' && url.pathname === '/open-folder') {
      const { file } = await readBody(req);
      if (file && inClips(file)) spawn('explorer.exe', ['/select,"' + path.resolve(file) + '"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      else spawn('explorer.exe', ['"' + CLIPS_DIR + '"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/copy-file') {
      const { file } = await readBody(req);
      if (!file || !inClips(file)) return send(res, 400, { error: 'bad file' });
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:CLIPPER_FILE'], { env: Object.assign({}, process.env, { CLIPPER_FILE: path.resolve(file) }), windowsHide: true });
      p.on('close', (c) => send(res, c === 0 ? 200 : 500, { ok: c === 0 }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/debug') {
      const b = await readBody(req);
      fs.writeFileSync(path.join(__dirname, 'debug-dump.json'), JSON.stringify(b, null, 2));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error('Clipper helper already running on port ' + PORT); process.exit(0); }
  console.error(e); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('Stremio Clipper helper on http://127.0.0.1:' + PORT + ' encoder=' + ff.getEncoder() + ' ffmpeg=' + (ff.tools && ff.tools.ffmpeg));
});
