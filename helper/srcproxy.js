'use strict';
// Local caching range proxy. ffmpeg/ffprobe read the stream through http://127.0.0.1:PORT/src/<key> instead of
// hitting the debrid CDN directly. Bytes are fetched upstream once in aligned chunks (max 2 connections at a time,
// backoff on 429/5xx) and served from a disk cache afterwards, so trimming/scrubbing doesn't get us rate limited.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CHUNK = 2 * 1024 * 1024;
const MAX_CACHE = 2 * 1024 * 1024 * 1024;
const MAX_UP = 2;
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));

function create({ port, resolveSrc }) {
  const dir = path.join(os.tmpdir(), 'stremio-clipper-cache');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(dir, { recursive: true });

  const stats = { requests: 0, bytes: 0, cacheHits: 0, last429At: 0, statuses: {} };
  const metas = new Map();    // key -> { key, orig, total }
  const index = new Map();    // 'key/n' -> size (insertion order = LRU)
  const inflight = new Map(); // 'key/n' -> Promise<Buffer>
  let cached = 0, up = 0;
  const waiters = [];

  const chunkFile = (key, n) => path.join(dir, key + '_' + n);
  function acquire() {
    if (up < MAX_UP) { up++; return Promise.resolve(); }
    return new Promise((r) => waiters.push(r));
  }
  function release() { const w = waiters.shift(); if (w) w(); else up--; }

  function srcFor(orig) {
    const key = crypto.createHash('sha1').update(orig).digest('hex').slice(0, 16);
    if (!metas.has(key)) {
      metas.set(key, { key, orig, total: 0 });
      if (metas.size > 50) metas.delete(metas.keys().next().value);
    }
    return 'http://127.0.0.1:' + port + '/src/' + key;
  }

  function store(key, n, buf) {
    const k = key + '/' + n;
    if (!index.has(k)) { index.set(k, buf.length); cached += buf.length; }
    fs.writeFile(chunkFile(key, n), buf, () => {});
    while (cached > MAX_CACHE && index.size > 1) {
      const [ek, sz] = index.entries().next().value;
      index.delete(ek); cached -= sz;
      const parts = ek.split('/');
      fs.unlink(chunkFile(parts[0], parts[1]), () => {});
    }
  }

  // One upstream range request. Resolves { status, headers, body } (body only for 200/206).
  function request(url, start, end) {
    return new Promise((resolve) => {
      let lib;
      try { lib = new URL(url).protocol === 'https:' ? https : http; } catch (_) { return resolve({ status: 0 }); }
      const r = lib.get(url, { headers: { Range: 'bytes=' + start + '-' + end, 'User-Agent': 'stremio-clipper' }, timeout: 30000 }, (x) => {
        if (x.statusCode !== 206 && x.statusCode !== 200) { x.resume(); return resolve({ status: x.statusCode, headers: x.headers }); }
        const parts = []; let got = 0, done = false;
        x.on('data', (d) => {
          parts.push(d); got += d.length;
          if (x.statusCode === 200 && got >= end + 1) x.destroy(); // server ignored Range: keep what we asked for
        });
        const fin = () => { if (done) return; done = true; resolve({ status: x.statusCode, headers: x.headers, body: Buffer.concat(parts) }); };
        x.on('end', fin); x.on('close', fin);
        x.on('error', () => { if (!done) { done = true; resolve({ status: 0 }); } });
      });
      r.on('error', () => resolve({ status: 0 }));
      r.on('timeout', () => { r.destroy(); resolve({ status: 0 }); });
    });
  }

  async function fetchChunk(meta, n) {
    const start = n * CHUNK;
    let refreshed = false;
    for (let attempt = 0; attempt < 7; attempt++) {
      let end = start + CHUNK - 1;
      if (meta.total) { if (start >= meta.total) throw new Error('range past end'); end = Math.min(end, meta.total - 1); }
      await acquire();
      let r;
      try {
        const url = await resolveSrc(meta.orig);
        r = await request(url, start, end);
      } finally { release(); }
      stats.requests++;
      stats.statuses[r.status] = (stats.statuses[r.status] || 0) + 1;
      if (r.status === 206 || r.status === 200) {
        let body = r.body;
        const cr = /\/(\d+)\s*$/.exec(String(r.headers['content-range'] || ''));
        if (cr) meta.total = parseInt(cr[1], 10);
        else if (r.status === 200 && r.headers['content-length']) meta.total = parseInt(r.headers['content-length'], 10);
        if (r.status === 200 && start > 0) throw new Error('upstream ignores Range');
        if (body.length > end - start + 1) body = body.subarray(0, end - start + 1);
        stats.bytes += body.length;
        return body;
      }
      if (r.status === 429 || r.status >= 500 || r.status === 0) {
        if (r.status === 429) stats.last429At = Date.now();
        const ra = r.headers && parseInt(r.headers['retry-after'], 10);
        await sleep(((ra && ra <= 30) ? ra : Math.min(1.5 * Math.pow(2, attempt), 12)) * 1000);
        continue;
      }
      if (r.status === 416) throw new Error('range not satisfiable');
      // other 4xx / odd redirect: stale or used link, resolve again once
      if (!refreshed) { refreshed = true; await resolveSrc(meta.orig, true); continue; }
      throw new Error('Server returned ' + r.status + ' (stream)');
    }
    throw new Error('Server returned 429/5XX after retries (stream)');
  }

  async function getChunk(meta, n, quiet) {
    const k = meta.key + '/' + n;
    if (index.has(k)) {
      try {
        const b = await fs.promises.readFile(chunkFile(meta.key, n));
        const sz = index.get(k); index.delete(k); index.set(k, sz); // refresh LRU
        if (!quiet) stats.cacheHits++;
        return b;
      } catch (_) { cached -= index.get(k) || 0; index.delete(k); }
    }
    let p = inflight.get(k);
    if (!p) {
      p = fetchChunk(meta, n).then((b) => { store(meta.key, n, b); return b; }).finally(() => inflight.delete(k));
      inflight.set(k, p);
    }
    return p;
  }
  function prefetch(meta, n, lastN) {
    const k = meta.key + '/' + n;
    if (n > lastN || (meta.total && n * CHUNK >= meta.total) || index.has(k) || inflight.has(k)) return;
    getChunk(meta, n, true).catch(() => {});
  }

  async function handle(req, res) {
    const m = /^\/src\/([a-f0-9]+)$/.exec(new URL(req.url, 'http://x').pathname);
    const meta = m && metas.get(m[1]);
    const fail = (code, msg) => { if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg || ''); };
    if (!meta) return fail(404, 'unknown source');
    let closed = false;
    res.on('close', () => { closed = true; });
    try {
      const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      let a = rg && rg[1] !== '' ? parseInt(rg[1], 10) : null;
      let b = rg && rg[2] !== '' ? parseInt(rg[2], 10) : null;
      // the first chunk we need also tells us the total size
      let firstN = a != null ? Math.floor(a / CHUNK) : 0;
      let first = await getChunk(meta, firstN);
      const total = meta.total;
      if (!total) return fail(502, 'unknown size');
      if (rg && a == null) { a = Math.max(0, total - b); b = total - 1; } // suffix range
      if (a == null) a = 0;
      if (b == null || b >= total) b = total - 1;
      if (a > b || a >= total) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end(); }
      if (Math.floor(a / CHUNK) !== firstN) { firstN = Math.floor(a / CHUNK); first = await getChunk(meta, firstN); }
      res.writeHead(rg ? 206 : 200, Object.assign({
        'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1
      }, rg ? { 'Content-Range': 'bytes ' + a + '-' + b + '/' + total } : {}));
      if (req.method === 'HEAD') return res.end();
      const lastN = Math.floor(b / CHUNK), multi = lastN > firstN || b === total - 1;
      for (let n = firstN; n <= lastN && !closed; n++) {
        const buf = n === firstN ? first : await getChunk(meta, n);
        if (multi) { prefetch(meta, n + 1, lastN); prefetch(meta, n + 2, lastN); }
        const s = Math.max(a, n * CHUNK) - n * CHUNK, e = Math.min(b, n * CHUNK + CHUNK - 1) - n * CHUNK + 1;
        if (!res.write(buf.subarray(s, e)) && !closed) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
      }
      res.end();
    } catch (e) {
      if (res.headersSent) res.destroy(); else fail(502, String((e && e.message) || e));
    }
  }

  return { srcFor, handle, stats };
}

module.exports = { create };
