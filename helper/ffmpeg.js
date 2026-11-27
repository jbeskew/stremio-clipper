'use strict';
// ffmpeg / ffprobe discovery, probing and clip encoding.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

function candidateDirs() {
  const dirs = [];
  if (process.env.FFMPEG_DIR) dirs.push(process.env.FFMPEG_DIR);
  const local = process.env.LOCALAPPDATA;
  if (local) {
    dirs.push(path.join(local, 'Programs', 'Stremio'));
    dirs.push(path.join(local, 'Programs', 'StremioService'));
    dirs.push(path.join(local, 'Microsoft', 'WinGet', 'Packages', 'Stremio.StremioService_Microsoft.Winget.Source_8wekyb3d8bbwe'));
  }
  const appdata = process.env.APPDATA;
  if (appdata) dirs.push(path.join(appdata, 'stremio-enhanced', 'streamingserver'));
  (process.env.PATH || '').split(path.delimiter).forEach((d) => d && dirs.push(d));
  return dirs;
}

function works(bin) {
  try {
    const r = spawnSync(bin, ['-version'], { timeout: 8000, windowsHide: true });
    return r.status === 0;
  } catch (_) { return false; }
}

function findTools() {
  for (const d of candidateDirs()) {
    const ff = path.join(d, 'ffmpeg' + EXE);
    const fp = path.join(d, 'ffprobe' + EXE);
    if (fs.existsSync(ff) && fs.existsSync(fp) && works(ff) && works(fp)) return { ffmpeg: ff, ffprobe: fp };
  }
  return null;
}

const tools = findTools();

// Detect the best working H.264 encoder (hardware first, libx264 fallback).
let encoder = 'libx264';
function detectEncoder() {
  if (!tools) return encoder;
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    const r = spawnSync(tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.2',
      '-c:v', enc, '-frames:v', '3', '-f', 'null', '-'
    ], { timeout: 15000, windowsHide: true });
    if (r.status === 0) { encoder = enc; break; }
  }
  return encoder;
}
detectEncoder();

function parseRate(s) {
  if (!s) return 0;
  const [a, b] = String(s).split('/');
  const n = parseFloat(a), d = b === undefined ? 1 : parseFloat(b);
  return d ? n / d : 0;
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('timeout')); }, timeoutMs || 30000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(err.split('\n').slice(-6).join('\n') || ('exit ' + code))); });
  });
}

async function probe(url) {
  if (!tools) throw new Error('ffmpeg not found');
  const out = await run(tools.ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
    '-analyzeduration', '5000000', '-probesize', '10000000', url
  ], 40000);
  const j = JSON.parse(out);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('no video stream');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const duration = parseFloat((j.format && j.format.duration) || v.duration || 0) || 0;
  const fmtKbps = j.format && j.format.bit_rate ? parseInt(j.format.bit_rate, 10) / 1000 : 0;
  const audKbps = audio[0] && audio[0].bit_rate ? parseInt(audio[0].bit_rate, 10) / 1000 : 0;
  let videoKbps = v.bit_rate ? parseInt(v.bit_rate, 10) / 1000 : 0;
  if (!videoKbps && fmtKbps) videoKbps = Math.max(fmtKbps - (audKbps || 192), fmtKbps * 0.6);
  if (!videoKbps && j.format && j.format.size && duration) videoKbps = (parseInt(j.format.size, 10) * 8) / 1000 / duration * 0.92;
  return {
    width: v.width, height: v.height,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 24,
    codec: v.codec_name, duration, videoKbps: Math.round(videoKbps || 0),
    audio: audio.map((s, i) => ({ index: i, codec: s.codec_name, lang: s.tags && s.tags.language, title: s.tags && s.tags.title, channels: s.channels, default: !!(s.disposition && s.disposition.default) })),
    subtitles: subs.map((s, i) => ({ index: i, codec: s.codec_name, lang: s.tags && s.tags.language, title: s.tags && s.tags.title })),
    encoder
  };
}

const IMAGE_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'stremio-clipper' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('subtitle HTTP ' + res.statusCode)); }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => ws.close(resolve));
      ws.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(new Error('subtitle timeout')));
    req.on('error', reject);
  });
}

// Build ass file shifted so that t=0 is the clip start. Returns true on success.
async function prepareSubs(sub, url, start, dur, tmp) {
  const out = path.join(tmp, 'sub.ass');
  try {
    if (sub.type === 'external') {
      const raw = path.join(tmp, 'sub_raw.srt');
      await download(sub.url, raw);
      await run(tools.ffmpeg, ['-y', '-v', 'error', '-ss', String(start), '-i', raw, '-t', String(dur), out], 30000);
    } else if (sub.type === 'embedded') {
      await run(tools.ffmpeg, ['-y', '-v', 'error', '-ss', String(start), '-i', url, '-t', String(dur), '-map', '0:s:' + sub.index, out], 120000);
    }
    return fs.existsSync(out) && fs.statSync(out).size > 0;
  } catch (e) {
    return false;
  }
}

function videoArgs(enc, kbps) {
  const b = Math.max(100, Math.round(kbps));
  const common = ['-b:v', b + 'k', '-maxrate', Math.round(b * 1.25) + 'k', '-bufsize', b * 2 + 'k'];
  if (enc === 'h264_nvenc') return ['-c:v', enc, '-preset', 'p5', '-profile:v', 'high', ...common];
  if (enc === 'h264_qsv') return ['-c:v', enc, '-profile:v', 'high', ...common];
  if (enc === 'h264_amf') return ['-c:v', enc, '-quality', 'quality', ...common];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', ...common];
}

function runEncode(args, cwd, dur, onProgress, setProc) {
  return new Promise((resolve) => {
    const p = spawn(tools.ffmpeg, args, { cwd, windowsHide: true });
    setProc(p);
    let err = '', buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m) onProgress(Math.min(0.99, (parseInt(m[1], 10) / 1e6) / dur));
      }
    });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', (e) => resolve({ code: -1, err: String(e) }));
    p.on('close', (code) => resolve({ code, err }));
  });
}

// opts: {url,start,end,height,fps,videoKbps,audioIndex,subtitle,srcHeight,srcFps,outFile}
async function encodeClip(opts, job) {
  if (!tools) throw new Error('ffmpeg not found');
  const dur = Math.max(0.5, opts.end - opts.start);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stremio-clip-'));
  job.tmp = tmp;
  const notes = [];
  try {
    let subMode = null; // 'ass' | 'image'
    if (opts.subtitle) {
      if (opts.subtitle.type === 'embedded' && IMAGE_SUBS.has(opts.subtitle.codec)) subMode = 'image';
      else if (await prepareSubs(opts.subtitle, opts.url, opts.start, dur, tmp)) subMode = 'ass';
      else notes.push('Subtitles could not be prepared; clip saved without them.');
    }

    const attempt = (enc, withSubs) => {
      const scale = 'scale=-2:' + Math.round(opts.height / 2) * 2;
      const fpsF = opts.fps && opts.srcFps && opts.fps < opts.srcFps - 0.5 ? ',fps=' + opts.fps : '';
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
        '-ss', String(opts.start), '-i', opts.url, '-t', String(dur)];
      const aIdx = opts.audioIndex || 0;
      if (withSubs && subMode === 'image') {
        args.push('-filter_complex', '[0:v:0][0:s:' + opts.subtitle.index + ']overlay,' + scale + fpsF + ',format=yuv420p[v]', '-map', '[v]');
      } else {
        let vf = scale + fpsF;
        if (withSubs && subMode === 'ass') vf += ",subtitles=sub.ass";
        vf += ',format=yuv420p';
        args.push('-map', '0:v:0', '-vf', vf);
      }
      args.push('-map', '0:a:' + aIdx + '?', ...videoArgs(enc, opts.videoKbps),
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', '-sn', opts.outFile);
      return args;
    };

    const tries = [[encoder, true]];
    if (encoder !== 'libx264') tries.push(['libx264', true]);
    if (subMode) tries.push(['libx264', false]);
    let last = null;
    for (const [enc, withSubs] of tries) {
      if (job.cancelled) throw new Error('cancelled');
      try { fs.unlinkSync(opts.outFile); } catch (_) {}
      const r = await runEncode(attempt(enc, withSubs), tmp, dur, (f) => { job.progress = f; }, (p) => { job.proc = p; });
      if (r.code === 0 && fs.existsSync(opts.outFile)) {
        if (subMode && !withSubs) notes.push('Subtitle burn-in failed; clip saved without subtitles.');
        return { notes, encoder: enc };
      }
      last = r.err;
    }
    throw new Error((last || 'ffmpeg failed').trim().split('\n').slice(-4).join(' | '));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

// Grab one JPEG frame at time t. o: {height, keyOnly, fast, q, signal}. Returns a Buffer.
// keyOnly: nearest keyframe only (filmstrip). fast: nearest keyframe before t, no decode-to-exact. Neither: exact frame.
function grabOnce(url, t, o, limitProbe) {
  const h = Math.round(clampNum(o.height, 24, 1080) / 2) * 2;
  const args = ['-v', 'error'];
  if (limitProbe) args.push('-probesize', '2000000', '-analyzeduration', '2000000');
  if (o.keyOnly) args.push('-skip_frame', 'nokey');
  if (o.fast) args.push('-noaccurate_seek');
  args.push('-ss', String(Math.max(0, t)), '-i', url, '-frames:v', '1', '-an', '-sn',
    '-vf', 'scale=-2:min(ih\\,' + h + ')', '-q:v', String(o.q || 5), '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1');
  return new Promise((resolve, reject) => {
    const sig = o.signal;
    if (sig && sig.aborted) return reject(new Error('aborted'));
    const p = spawn(tools.ffmpeg, args, { windowsHide: true });
    const chunks = [];
    let err = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); if (sig) sig.removeEventListener('abort', onAbort); fn(v); };
    const onAbort = () => { try { p.kill(); } catch (_) {} finish(reject, new Error('aborted')); };
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} finish(reject, new Error('timeout')); }, 30000);
    if (sig) sig.addEventListener('abort', onAbort, { once: true });
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000); });
    p.on('error', (e) => finish(reject, e));
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length) finish(resolve, buf);
      else finish(reject, new Error(err.trim().split('\n').slice(-2).join(' | ') || 'no frame'));
    });
  });
}
async function grab(url, t, o) {
  if (!tools) throw new Error('ffmpeg not found');
  try { return await grabOnce(url, t, o, true); }
  catch (e) {
    if (String(e.message) === 'aborted' || (o.signal && o.signal.aborted)) throw e;
    return grabOnce(url, t, o, false); // retry without the probe limits
  }
}
function clampNum(v, a, b) { v = Number(v); if (!isFinite(v)) v = a; return Math.min(Math.max(v, a), b); }

module.exports = { tools, probe, encodeClip, grab, getEncoder: () => encoder };
