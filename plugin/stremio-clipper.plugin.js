/**
 * @name Stremio Clipper
 * @description Adds a Clip button to the player. Twitch-style clip editor: trim bar, title, quality/FPS with size estimates, subtitles, MP4 saved to the "stremio clips" folder. Requires the Stremio Clipper helper (see README).
 * @version 1.0.0
 * @author Stremio Clipper
 */

(function () {
  if (window.__stremioClipper) return;
  window.__stremioClipper = true;

  const API = 'http://127.0.0.1:47811';
  const BTN_CLASS = 'clipper-plugin-button';
  const AUDIO_KBPS = 160;
  const QUALITIES = [2160, 1440, 1080, 720, 480, 360];
  const FPS_OPTIONS = [60, 50, 30, 25, 24, 15];
  const BITRATE_CEIL = { 360: 1400, 480: 2800, 720: 5500, 1080: 10000, 1440: 14000, 2160: 25000 };
  const U = (c) => String.fromCharCode(c);
  const DASH = U(0x2014), ELLIP = U(0x2026), APPROX = U(0x2248), CHECK = U(0x2713);
  const DEFAULT_LEN = 30;
  const MIN_LEN = 1;

  /* ---------- small helpers ---------- */
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const pad2 = (n) => String(n).padStart(2, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function h(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function fmtTime(t) {
    t = Math.max(0, Math.round((t || 0) * 10) / 10);
    const hr = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const sec = (s < 10 ? '0' : '') + s.toFixed(1);
    return hr ? hr + ':' + pad2(m) + ':' + sec : m + ':' + sec;
  }
  function fmtShort(t) {
    t = Math.max(0, Math.round(t || 0));
    const hr = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return hr ? hr + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  function parseTime(str) {
    const parts = String(str).trim().split(':').map(Number);
    if (!parts.length || parts.some((n) => !isFinite(n))) return null;
    let t = 0;
    for (const p of parts) t = t * 60 + p;
    return t;
  }
  function fmtSize(bytes) {
    const mb = bytes / 1e6;
    if (mb >= 1000) return (mb / 1000).toFixed(2) + ' GB';
    return (mb < 10 ? mb.toFixed(2) : mb.toFixed(1)) + ' MB';
  }
  async function api(path, body, timeout) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout || 60000);
    try {
      const r = await fetch(API + path, body === undefined ? { signal: ctl.signal } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    } finally { clearTimeout(t); }
  }

  function toast(msg) {
    const t = h('div', 'clp-toast', esc(msg));
    t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 18px;border-radius:8px;z-index:2147483001;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.5)';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  /* ---------- player access ---------- */
  function pickVideo() {
    const vs = Array.from(document.querySelectorAll('video'));
    if (!vs.length) return null;
    const score = (v) => {
      const r = v.getBoundingClientRect();
      return (!v.paused ? 1e12 : 0) + (r.width > 0 && r.height > 0 ? 1e9 : 0) + r.width * r.height;
    };
    return vs.sort((a, b) => score(b) - score(a))[0];
  }

  async function getPlayerState() {
    const tries = [
      () => window.services && window.services.core && window.services.core.transport && window.services.core.transport.getState('player'),
      () => window.core && window.core.getState && window.core.getState('player'),
      () => window.core && window.core.transport && window.core.transport.getState('player')
    ];
    for (const f of tries) {
      try { const s = await f(); if (s) return s; } catch (_) {}
    }
    return null;
  }

  function resolveStreamUrls(state, video) {
    const urls = [];
    let s = state && state.stream;
    if (s && s.content) s = s.content;
    if (s) {
      if (s.url) urls.push(s.url);
      else if (s.infoHash) urls.push('http://127.0.0.1:11470/' + s.infoHash + '/' + (s.fileIdx != null ? s.fileIdx : -1));
    }
    const cur = video && (video.currentSrc || video.src);
    if (cur && /^https?:/i.test(cur)) urls.push(cur);
    return urls.filter((u, i) => urls.indexOf(u) === i);
  }

  function defaultTitle(state) {
    const meta = state && state.metaItem && state.metaItem.content;
    let t = (meta && meta.name) || (document.title && document.title !== 'Stremio' ? document.title : 'Clip');
    const si = state && state.seriesInfo;
    if (meta && si && si.season != null && si.episode != null) {
      t += ' - S' + pad2(si.season) + 'E' + pad2(si.episode);
      const ep = (meta.videos || []).find((v) => v.season === si.season && (v.episode === si.episode || v.number === si.episode));
      const et = ep && (ep.title || ep.name);
      if (et) t += ' - ' + et;
    }
    return t.slice(0, 100);
  }

  function collectExternalSubs(state) {
    const out = [];
    const subs = state && state.subtitles;
    const lists = Array.isArray(subs) ? subs : subs ? [subs] : [];
    for (const l of lists) {
      const content = l && (Array.isArray(l.content) ? l.content : Array.isArray(l) ? l : null);
      if (!content) continue;
      for (const s of content) if (s && s.url) out.push({ type: 'external', url: s.url, lang: s.lang || s.id || 'sub', label: s.label });
    }
    return out;
  }

  /* ---------- styles ---------- */
  const CSS = `
  .clp-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.82);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:10px;padding:12px 0;box-sizing:border-box;font-family:inherit;color:#fff;user-select:none}
  .clp-panel{width:min(940px,98vw);flex:none;background:rgba(18,18,24,.97);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:16px 18px;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  .clp-head{display:flex;gap:10px;align-items:center;margin-bottom:12px}
  .clp-head label{font-size:12px;opacity:.7;text-transform:uppercase;letter-spacing:.06em}
  .clp-title{flex:1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#fff;padding:8px 10px;font-size:14px;outline:none;user-select:text}
  .clp-title:focus,.clp-time:focus{border-color:#ffd400}
  .clp-x{background:none;border:none;color:#fff;opacity:.7;font-size:20px;cursor:pointer}
  .clp-x:hover{opacity:1}
  .clp-cap{display:flex;justify-content:space-between;font-size:11px;opacity:.65;margin:2px 0 4px}
  .clp-full{position:relative;height:40px;background:rgba(255,255,255,.12);border-radius:4px;cursor:pointer;touch-action:none;margin-bottom:10px}
  .clp-fwin{position:absolute;top:-2px;bottom:-2px;border:2px solid rgba(255,255,255,.6);border-radius:4px;pointer-events:none}
  .clp-fsel{position:absolute;top:0;bottom:0;background:rgba(255,212,0,.3);border:2px solid #ffd400;box-sizing:border-box;border-radius:3px;min-width:6px;cursor:grab}
  .clp-zoom{position:relative;height:56px;background:rgba(255,255,255,.1);border-radius:6px;touch-action:none;margin-bottom:6px}
  .clp-sel{position:absolute;top:0;bottom:0;background:rgba(255,212,0,.12);border-top:3px solid #ffd400;border-bottom:3px solid #ffd400;cursor:grab}
  .clp-hd{position:absolute;top:-4px;bottom:-4px;width:14px;margin-left:-7px;background:#ffd400;border-radius:4px;cursor:ew-resize;display:flex;align-items:center;justify-content:center}
  .clp-hd:after{content:"";width:2px;height:20px;background:rgba(0,0,0,.55);border-radius:1px}
  .clp-ph{position:absolute;top:-3px;bottom:-3px;width:2px;background:#fff;pointer-events:none;display:none;box-shadow:0 0 4px #000}
  .clp-row{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:12px}
  .clp-time{width:86px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#fff;padding:6px 8px;font-size:13px;text-align:center;outline:none;user-select:text}
  .clp-len{font-size:13px;opacity:.85}
  .clp-btn{background:rgba(255,255,255,.12);border:none;color:#fff;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer}
  .clp-btn:hover{background:rgba(255,255,255,.2)}
  .clp-btn.primary{background:#ffd400;color:#111;font-weight:600}
  .clp-btn.primary:hover{background:#ffe03a}
  .clp-btn[disabled]{opacity:.4;pointer-events:none}
  .clp-grow{flex:1}
  .clp-dd{position:relative}
  .clp-dd-btn{min-width:130px;display:flex;justify-content:space-between;gap:8px;align-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:8px;padding:8px 10px;font-size:13px;cursor:pointer}
  .clp-dd-btn:after{content:"\\25BE";opacity:.7}
  .clp-dd-btn[disabled]{opacity:.4;pointer-events:none}
  .clp-dd-menu{display:none;position:absolute;bottom:calc(100% + 4px);left:0;min-width:100%;max-height:260px;overflow:auto;background:#1b1b24;border:1px solid rgba(255,255,255,.18);border-radius:8px;z-index:5;padding:4px}
  .clp-dd-menu.open{display:block}
  .clp-opt{display:flex;justify-content:space-between;gap:16px;padding:7px 10px;border-radius:6px;font-size:13px;cursor:pointer;white-space:nowrap}
  .clp-opt:hover{background:rgba(255,255,255,.1)}
  .clp-opt.sel{color:#ffd400}
  .clp-opt small{opacity:.6;font-size:11px;align-self:center}
  .clp-size{font-size:14px;font-weight:600;color:#ffd400;min-width:90px;text-align:center}
  .clp-lbl{font-size:11px;opacity:.6;text-transform:uppercase;letter-spacing:.06em;margin-right:-6px}
  .clp-sw{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
  .clp-sw i{width:34px;height:18px;border-radius:9px;background:rgba(255,255,255,.2);position:relative;transition:background .15s}
  .clp-sw i:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
  .clp-sw.on i{background:#ffd400}.clp-sw.on i:after{left:18px}
  .clp-sw.dis{opacity:.4;pointer-events:none}
  .clp-status{margin-top:12px;font-size:13px;min-height:18px}
  .clp-status.err{color:#ff7b7b}
  .clp-prog{height:6px;background:rgba(255,255,255,.12);border-radius:3px;margin-top:8px;overflow:hidden}
  .clp-prog>div{height:100%;width:0;background:#ffd400;transition:width .3s}
  .clp-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 18px;border-radius:8px;z-index:2147483001;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.5)}
  .clp-strip{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none}
  .clp-tile{flex:1 1 0;min-width:0;background-size:cover;background-position:center;background-color:rgba(255,255,255,.05)}
  .clp-tile.on{background-color:#000}
  .clp-dim{position:absolute;top:0;bottom:0;background:rgba(0,0,0,.55)}
  .clp-pv{position:relative;width:min(940px,98vw);flex:1 1 auto;min-height:140px;background:#000;border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  .clp-pv:fullscreen{width:100vw;height:100vh;border-radius:0;border:none}
  .clp-pv.max{position:fixed;inset:0;width:auto;height:auto;border-radius:0;border:none;z-index:5}
  .clp-cv{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;border-radius:11px;cursor:pointer;background:#000}
  .clp-tag{display:none;position:absolute;top:12px;left:14px;background:rgba(0,0,0,.7);border:1px solid #ffd400;color:#ffd400;font-size:12px;font-weight:600;letter-spacing:.04em;padding:4px 10px;border-radius:6px;pointer-events:none}
  .clp-pc{position:absolute;left:0;right:0;bottom:0;display:flex;gap:12px;align-items:center;padding:28px 14px 10px;background:linear-gradient(transparent,rgba(0,0,0,.85));border-radius:0 0 11px 11px}
  .clp-pb{background:none;border:none;color:#fff;cursor:pointer;width:32px;height:32px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:6px}
  .clp-pb:hover{background:rgba(255,255,255,.18)}
  .clp-scrub{position:relative;flex:1;height:20px;cursor:pointer;touch-action:none}
  .clp-sct{position:absolute;left:0;right:0;top:7px;height:6px;border-radius:3px;background:rgba(255,255,255,.28);overflow:hidden}
  .clp-scf{height:100%;width:0;background:#ffd400}
  .clp-sck{position:absolute;top:3px;left:0;width:4px;height:14px;margin-left:-2px;border-radius:2px;background:#fff;box-shadow:0 0 4px #000}
  .clp-pt{font-size:12px;font-variant-numeric:tabular-nums;opacity:.9;min-width:104px;text-align:center}
  .clp-setend{padding:7px 12px;font-size:12px}
  .clp-pvid{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;border-radius:11px;background:#000;cursor:pointer;display:none}
  .clp-busy{display:none;position:absolute;top:12px;right:14px;background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.25);font-size:12px;padding:4px 10px;border-radius:6px;pointer-events:none;max-width:60%}
  .clp-vol{display:flex;align-items:center;gap:2px}
  .clp-vbar{position:relative;width:72px;height:20px;cursor:pointer;touch-action:none}
  .clp-vt{position:absolute;left:0;right:0;top:7px;height:6px;border-radius:3px;background:rgba(255,255,255,.28);overflow:hidden}
  .clp-vf{height:100%;width:0;background:#fff}
  .clp-vk{position:absolute;top:4px;left:0;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#fff;box-shadow:0 0 4px #000}
  .${BTN_CLASS}{cursor:pointer}
  `;

  /* ---------- dropdown ---------- */
  const dropdowns = [];
  function Dropdown(onChange) {
    const root = h('div', 'clp-dd');
    const btn = h('button', 'clp-dd-btn');
    const menu = h('div', 'clp-dd-menu');
    root.append(btn, menu);
    let opts = [], value = null;
    const api2 = {
      el: root,
      setOptions(list) { opts = list; render(); },
      setValue(v) { value = v; render(); },
      get value() { return value; },
      disable(d) { btn.disabled = d; },
      close() { menu.classList.remove('open'); }
    };
    function render() {
      const cur = opts.find((o) => o.value === value) || opts[0];
      btn.innerHTML = '<span>' + esc(cur ? cur.label : DASH) + '</span>';
      menu.innerHTML = '';
      opts.forEach((o) => {
        const row = h('div', 'clp-opt' + (o.value === value ? ' sel' : ''), '<span>' + esc(o.label) + '</span><small>' + esc(o.sub || '') + '</small>');
        row.addEventListener('click', (e) => { e.stopPropagation(); value = o.value; menu.classList.remove('open'); render(); onChange && onChange(o.value); });
        menu.appendChild(row);
      });
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains('open');
      dropdowns.forEach((d) => d.close());
      if (open) menu.classList.add('open');
    });
    dropdowns.push(api2);
    return api2;
  }

  /* ---------- the editor ---------- */
  let active = null;

  async function openEditor() {
    if (active) return;
    const video = pickVideo();
    if (!video) return toast('Clipper: no video found');
    try { await api('/health', undefined, 2500); } catch (_) {
      return toast('Clipper helper is not running. Run install.ps1 or start-hidden.vbs (see README).');
    }

    const T = video.currentTime || 0;
    video.pause();
    const wasFullscreen = !!document.fullscreenElement;
    const S = {
      video, T, D: video.duration && isFinite(video.duration) ? video.duration : 0,
      start: Math.max(0, T - DEFAULT_LEN), end: T, zs: 0, ze: 0,
      probe: null, state: null, url: null,
      height: 0, fps: 0, subs: [], subOn: false, subIdx: 0, audioIndex: 0,
      previewing: false, saving: false, job: null, raf: 0,
      parked: true, mark: null, seeking: false, shownT: T, rate: 1, origRate: video.playbackRate || 1, fsExitAt: 0
    };
    if (S.end - S.start < MIN_LEN) { S.end = Math.min(S.D || T + MIN_LEN, S.start + MIN_LEN); }
    active = S;
    dropdowns.length = 0;

    // --- DOM ---
    const style = h('style'); style.textContent = CSS;
    const bd = h('div', 'clp-backdrop');
    const panel = h('div', 'clp-panel');
    const pv = h('div', 'clp-pv');
    pv.innerHTML = [
      '<canvas class="clp-cv"></canvas>',
      '<video class="clp-pvid" playsinline preload="auto"></video>',
      '<div class="clp-tag"></div>',
      '<div class="clp-busy"></div>',
      '<div class="clp-pc">',
      '<button class="clp-pb clp-pp" title="Play / pause (Space)"></button>',
      '<div class="clp-scrub"><div class="clp-sct"><div class="clp-scf"></div></div><div class="clp-sck"></div></div>',
      '<span class="clp-pt"></span>',
      '<div class="clp-vol"><button class="clp-pb clp-mute" title="Mute"></button><div class="clp-vbar" title="Volume"><div class="clp-vt"><div class="clp-vf"></div></div><div class="clp-vk"></div></div></div>',
      '<span class="clp-spd"></span>',
      '<button class="clp-pb clp-fs" title="Expand"></button>',
      '</div>'
    ].join('');
    bd.append(pv, panel);
    panel.innerHTML = `
      <div class="clp-head"><label>Title</label><input class="clp-title" maxlength="100" spellcheck="false"><button class="clp-x" title="Close (Esc)">&#10005;</button></div>
      <div class="clp-cap"><span>Full runtime</span><span class="clp-dur"></span></div>
      <div class="clp-full"><div class="clp-fwin"></div><div class="clp-fsel"></div><div class="clp-ph"></div></div>
      <div class="clp-cap"><span class="clp-zl"></span><span>Drag the yellow handles to trim</span><span class="clp-zr"></span></div>
      <div class="clp-zoom"><div class="clp-sel"></div><div class="clp-hd clp-hs"></div><div class="clp-hd clp-he"></div><div class="clp-ph"></div></div>
      <div class="clp-row clp-r1">
        
        <span class="clp-lbl">Start</span><input class="clp-time clp-ts"><span class="clp-lbl">End</span><input class="clp-time clp-te"><button class="clp-btn primary clp-setend" title="Use the preview's current time as the end point">Set end point</button>
        <span class="clp-len"></span>
      </div>
      <div class="clp-row clp-r2"></div>
      <div class="clp-status"></div>
      <div class="clp-prog" style="display:none"><div></div></div>
      <div class="clp-row clp-r3"><span class="clp-grow"></span></div>`;
    const host = document.createElement('div'); host.className = 'clp-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(style);
    shadow.append(bd);
    document.body.appendChild(host);
    window.__clpHost = host;

    const $ = (s) => panel.querySelector(s);
    const elTitle = $('.clp-title'), elFull = $('.clp-full'), elFwin = $('.clp-fwin'), elFsel = $('.clp-fsel');
    const elZoom = $('.clp-zoom'), elSel = $('.clp-sel'), elHs = $('.clp-hs'), elHe = $('.clp-he');
    const elPhFull = elFull.querySelector('.clp-ph'), elPhZoom = elZoom.querySelector('.clp-ph');
    const elTs = $('.clp-ts'), elTe = $('.clp-te'), elLen = $('.clp-len');
    const pq = (q) => pv.querySelector(q);
    const cv = pq('.clp-cv'), elTag = pq('.clp-tag'), elPlay = pq('.clp-pp'), elScrub = pq('.clp-scrub'), elScf = pq('.clp-scf'), elSck = pq('.clp-sck');
    const elPt = pq('.clp-pt'), elSpd = pq('.clp-spd'), elFs = pq('.clp-fs');
    const pvid = pq('.clp-pvid'), elBusy = pq('.clp-busy'), elMute = pq('.clp-mute'), elVol = pq('.clp-vbar'), elVf = pq('.clp-vf'), elVk = pq('.clp-vk');
    const stripF = makeStrip(elFull), stripZ = makeStrip(elZoom);
    const elStatus = $('.clp-status'), elProg = $('.clp-prog'), elProgBar = elProg.firstElementChild;
    const r2 = $('.clp-r2'), r3 = $('.clp-r3');

    // dropdowns + size + subtitles
    const ddQ = Dropdown(() => { S.height = ddQ.value; refresh(); });
    const ddF = Dropdown(() => { S.fps = ddF.value; refresh(); });
    const elSize = h('div', 'clp-size', DASH);
    const sw = h('div', 'clp-sw dis', '<i></i><span>Subtitles</span>');
    const ddS = Dropdown(() => { S.subIdx = ddS.value; checkDirty(); });
    ddS.el.style.display = 'none';
    // preview speed (affects only the preview, never the exported clip)
    const ddR = Dropdown((v) => setRate(v));
    ddR.setOptions([0.5, 1, 1.25, 1.5, 2].map((v) => ({ value: v, label: v + 'x', sub: '' })));
    ddR.setValue(1);
    ddR.el.querySelector('.clp-dd-btn').style.minWidth = '72px';
    elSpd.appendChild(ddR.el);
    const lblQ = h('span', 'clp-lbl', 'Quality'), lblF = h('span', 'clp-lbl', 'FPS');
    const ddA = Dropdown((v) => { S.audioIndex = v; onAudioChange(); checkDirty(); });
    const lblA = h('span', 'clp-lbl', 'Audio');
    ddA.el.style.display = 'none'; lblA.style.display = 'none';
    r2.append(lblQ, ddQ.el, elSize, lblF, ddF.el, lblA, ddA.el, h('span', 'clp-grow'), sw, ddS.el);
    const btnCancel = h('button', 'clp-btn', 'Cancel');
    const btnSave = h('button', 'clp-btn primary', 'Save Clip');
    btnSave.disabled = true;
    r3.append(btnCancel, btnSave);
    elTitle.value = defaultTitle(null); S.defTitle = elTitle.value;
    elTitle.addEventListener('input', () => checkDirty());

    const setStatus = (msg, err) => { elStatus.textContent = msg || ''; elStatus.className = 'clp-status' + (err ? ' err' : ''); };
    setStatus('Reading stream info' + ELLIP);

    // --- estimation ---
    const ceilFor = (hh) => BITRATE_CEIL[QUALITIES.slice().reverse().find((q) => hh <= q) || 2160];
    function kbpsFor(hh, fps) {
      const p = S.probe;
      let base = p.videoKbps || ceilFor(p.height) * 0.6;
      base = Math.min(base, ceilFor(p.height));
      let k = base * Math.pow(hh / p.height, 1.5) * Math.pow(fps / p.fps, 0.6);
      return Math.round(clamp(k, 150, ceilFor(hh)));
    }
    function sizeFor(hh, fps, dur) { return (kbpsFor(hh, fps) + AUDIO_KBPS) * 1000 * dur / 8 * 1.01; }
    const dur = () => S.end - S.start;

    // --- timeline geometry ---
    function recenter() {
      const D = S.D || S.end;
      if (D <= 300) { S.zs = 0; S.ze = D; return; }
      const span = Math.max(240, dur() + 120);
      const mid = (S.start + S.end) / 2;
      S.zs = clamp(mid - span / 2, 0, Math.max(0, D - span));
      S.ze = Math.min(D, S.zs + span);
    }
    const zx = (t) => ((t - S.zs) / (S.ze - S.zs)) * 100;
    function drawBars() {
      const D = S.D || S.end;
      elFsel.style.left = (S.start / D * 100) + '%';
      elFsel.style.width = (dur() / D * 100) + '%';
      elFwin.style.left = (S.zs / D * 100) + '%';
      elFwin.style.width = ((S.ze - S.zs) / D * 100) + '%';
      elSel.style.left = zx(S.start) + '%';
      elSel.style.width = (zx(S.end) - zx(S.start)) + '%';
      elHs.style.left = zx(S.start) + '%';
      elHe.style.left = zx(S.end) + '%';
      $('.clp-zl').textContent = fmtShort(S.zs);
      $('.clp-zr').textContent = fmtShort(S.ze);
      $('.clp-dur').textContent = fmtShort(D);
      if (shadow.activeElement !== elTs) elTs.value = fmtTime(S.start);
      if (shadow.activeElement !== elTe) elTe.value = fmtTime(S.end);
      elLen.textContent = 'Clip length ' + fmtTime(dur());
      setDims(stripF, S.start / D * 100, S.end / D * 100);
      setDims(stripZ, zx(S.start), zx(S.end));
      syncZoomStrip(false); updateScrub(); updateHeads(curT()); updateTag(); checkDirty();
    }
    function refreshSizes() {
      if (!S.probe) return;
      const d = dur(), p = S.probe;
      ddQ.setOptions(S.qualityList.map((q) => ({ value: q, label: q + 'p' + (q === p.height ? ' (Source)' : ''), sub: fmtSize(sizeFor(q, S.fps, d)) })));
      ddQ.setValue(S.height);
      ddF.setOptions(S.fpsList.map((f) => ({ value: f, label: fpsLabel(f) + ' fps' + (f === p.fps ? ' (Source)' : ''), sub: fmtSize(sizeFor(S.height, f, d)) })));
      ddF.setValue(S.fps);
      elSize.textContent = APPROX + ' ' + fmtSize(sizeFor(S.height, S.fps, d));
    }
    const fpsLabel = (f) => String(Math.round(f * 1000) / 1000);
    function refresh() { drawBars(); refreshSizes(); }

    // --- drag handling ---
    function drag(el, onMove, onEnd) {
      el.addEventListener('pointerdown', (e) => {
        if (S.saving) return;
        e.preventDefault(); e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        const move = (ev) => onMove(ev, e);
        const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); onEnd && onEnd(); };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        onMove(e, e);
      });
    }
    const zoomT = (ev) => { const r = elZoom.getBoundingClientRect(); return S.zs + clamp((ev.clientX - r.left) / r.width, 0, 1) * (S.ze - S.zs); };
    const fullT = (ev) => { const r = elFull.getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1) * (S.D || S.end); };
    const maxT = () => S.D || Infinity;
    const edgeRecenter = () => {
      const span = S.ze - S.zs;
      if (S.start < S.zs + span * 0.04 || S.end > S.ze - span * 0.04) { recenter(); refresh(); }
    };

    drag(elHs, (ev) => { stopPreview(); S.start = clamp(zoomT(ev), S.zs, S.end - MIN_LEN); parkAt('start'); refresh(); }, () => { edgeRecenter(); settle(); });
    drag(elHe, (ev) => { stopPreview(); S.end = clamp(zoomT(ev), S.start + MIN_LEN, Math.min(S.ze, maxT())); parkAt('end'); refresh(); }, () => { edgeRecenter(); settle(); });
    drag(elSel, (ev, first) => {
      stopPreview();
      if (S._grab == null || ev === first) S._grab = zoomT(first) - S.start;
      const len = dur();
      S.start = clamp(zoomT(ev) - S._grab, S.zs, Math.min(S.ze, maxT()) - len);
      S.end = S.start + len; parkAt('start'); refresh();
    }, () => { S._grab = null; edgeRecenter(); settle(); });
    drag(elFsel, (ev, first) => {
      stopPreview();
      if (S._grab == null || ev === first) S._grab = fullT(first) - S.start;
      const len = dur(), D = S.D || S.end;
      S.start = clamp(fullT(ev) - S._grab, 0, D - len); S.end = S.start + len; recenter(); parkAt('start'); refresh();
    }, () => { S._grab = null; settle(); });
    let pushed = false;
    drag(elFull, (ev) => {
      const D = S.D || S.end, span = S.ze - S.zs, t = fullT(ev), len = dur();
      S.zs = clamp(t - span / 2, 0, Math.max(0, D - span)); S.ze = Math.min(D, S.zs + span);
      // the yellow clip stays put inside the window; the window's edges push it along
      if (S.start < S.zs) { S.start = S.zs; S.end = S.start + len; pushed = true; parkAt('start'); }
      else if (S.end > S.ze) { S.end = S.ze; S.start = S.end - len; pushed = true; parkAt('end'); }
      drawBars();
    }, () => { if (pushed) { pushed = false; settle(); } });

    function commitInputs() {
      const a = parseTime(elTs.value), b = parseTime(elTe.value), os = S.start, oe = S.end;
      if (a != null) S.start = clamp(a, 0, (S.D || Infinity) - MIN_LEN);
      if (b != null) S.end = clamp(b, MIN_LEN, S.D || Infinity);
      if (S.end - S.start < MIN_LEN) { if (b != null && a == null) S.start = Math.max(0, S.end - MIN_LEN); else S.end = S.start + MIN_LEN; }
      stopPreview(); recenter(); parkAt(S.end !== oe && S.start === os ? 'end' : 'start'); refresh(); settle();
      elTs.value = fmtTime(S.start); elTe.value = fmtTime(S.end);
    }
    [elTs, elTe].forEach((i) => { i.addEventListener('change', commitInputs); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitInputs(); i.blur(); } }); });

    // --- preview window ---
    // Frames come from the helper (/frame) while trimming; playback uses a small preview file the helper
    // encodes for the trimmed range (/preview). Stremio's own player is only used for the very first frame.
    let closed = false, pxToken = 0, pxTimer = 0, pxId = null, pxRetried = false, pxUrl = null, zTimer = 0, zKey = '';
    let frameBusy = false, frameWant = null;
    const abortAll = new AbortController();
    const frames = new Map();
    const cx = cv.getContext('2d');
    S.px = { status: 'idle', key: '', progress: 0, msg: '' };
    S.frameLoading = false; S.playWhenReady = false; S.playFrom = 0; S.hasFrame = false; S.pvT = T; S.vol = 1; S.muted = false;
    const PLAY_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
    const PAUSE_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
    const EXPAND_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
    const VOL_ON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13"/></svg>';
    const VOL_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
    let basePs = 0; // absolute source time (s) at which the loaded preview file starts
    const proxyReady = () => S.px.status === 'ready' && S.start >= S.px.ps - 0.05 && S.end <= S.px.pe + 0.05;
    const inProxy = (t) => S.px.status === 'ready' && t >= S.px.ps - 0.05 && t <= S.px.pe + 0.05;
    const curT = () => (S.previewing ? basePs + pvid.currentTime : S.pvT);
    function setPlayIcon() { elPlay.innerHTML = (S.previewing || S.playWhenReady) ? PAUSE_SVG : PLAY_SVG; }

    // ----- filmstrip thumbnails -----
    const thumbs = new Map(), tq = [];
    let tActive = 0;
    function wantThumb(t, cb, front) {
      const k = Math.round(clamp(t, 0, Math.max(0, (S.D || S.end) - 0.5)));
      let e = thumbs.get(k);
      if (e && e.url) return cb(e.url);
      if (e) { e.cbs.push(cb); return; }
      e = { k, url: null, img: null, cbs: [cb] };
      thumbs.set(k, e);
      if (front) tq.unshift(e); else tq.push(e);
      pumpThumbs();
    }
    function pumpThumbs() {
      while (!closed && tActive < 3 && tq.length) {
        const e = tq.shift();
        tActive++;
        fetchThumb(e).then(() => { tActive--; pumpThumbs(); });
      }
    }
    async function fetchThumb(e) {
      try {
        const r = await fetch(API + '/thumb', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: S.url, t: e.k, h: 96 }), signal: abortAll.signal });
        if (!r.ok) throw new Error('thumb ' + r.status);
        const blob = await r.blob();
        if (closed) return;
        e.url = URL.createObjectURL(blob);
        e.img = new Image(); e.img.src = e.url;
        const cbs = e.cbs; e.cbs = [];
        cbs.forEach((fn) => fn(e.url));
      } catch (_) { thumbs.delete(e.k); }
    }
    function makeStrip(parent) {
      const el = h('div', 'clp-strip');
      const tiles = h('div');
      tiles.style.cssText = 'position:absolute;inset:0;display:flex';
      const dl = h('i', 'clp-dim'), dr = h('i', 'clp-dim');
      el.append(tiles, dl, dr);
      parent.insertBefore(el, parent.firstChild);
      return { el, tiles, dl, dr };
    }
    function setDims(st, p0, p1) {
      p0 = clamp(p0, 0, 100); p1 = clamp(p1, 0, 100);
      st.dl.style.cssText = 'left:0;width:' + p0 + '%';
      st.dr.style.cssText = 'right:0;left:' + p1 + '%';
    }
    function buildStrip(st, t0, t1, front) {
      const r = st.el.getBoundingClientRect();
      const n = Math.max(3, Math.ceil((r.width || 800) / (((r.height || 40) * 16) / 9)));
      st.tiles.innerHTML = '';
      const tiles = [];
      for (let i = 0; i < n; i++) { const t = h('div', 'clp-tile'); st.tiles.appendChild(t); tiles.push(t); }
      const order = tiles.map((_, i) => i);
      if (front) order.reverse(); // unshift keeps left-to-right fetch order
      order.forEach((i) => {
        const tm = t0 + ((i + 0.5) / n) * (t1 - t0);
        wantThumb(tm, (url) => { tiles[i].style.backgroundImage = 'url("' + url + '")'; tiles[i].classList.add('on'); }, front);
      });
    }
    function syncZoomStrip(imm) {
      if (!S.url) return;
      const key = S.zs + '|' + S.ze;
      if (key === zKey) return;
      zKey = key;
      clearTimeout(zTimer);
      if (imm) buildStrip(stripZ, S.zs, S.ze, true);
      else zTimer = setTimeout(() => buildStrip(stripZ, S.zs, S.ze, true), 200);
    }

    // ----- frame surface (canvas) -----
    function sizeCanvas(w, hh) { if (w && hh && (cv.width !== w || cv.height !== hh)) { cv.width = w; cv.height = hh; } }
    function drawImg(img) { try { sizeCanvas(img.naturalWidth, img.naturalHeight); cx.drawImage(img, 0, 0, cv.width, cv.height); S.hasFrame = true; } catch (_) {} }
    function drawFromVideo() {
      try {
        if (video.readyState >= 2 && video.videoWidth) { sizeCanvas(video.videoWidth, video.videoHeight); cx.drawImage(video, 0, 0, cv.width, cv.height); S.hasFrame = true; }
      } catch (_) {}
    }
    function drawPlaceholder(t) {
      let best = null, bestD = 1e9;
      thumbs.forEach((e) => { if (e.img && e.img.complete && e.img.naturalWidth) { const d = Math.abs(e.k - t); if (d < bestD) { bestD = d; best = e; } } });
      if (best) { if (!cv.width || cv.width < 640) sizeCanvas(best.img.naturalWidth, best.img.naturalHeight); try { cx.drawImage(best.img, 0, 0, cv.width, cv.height); } catch (_) {} }
    }
    function showFrameMode() { cv.style.display = 'block'; pvid.style.display = 'none'; }
    function showVideoMode() { cv.style.display = 'none'; pvid.style.display = 'block'; }
    const fk = (t, fast) => t.toFixed(2) + (fast ? 'f' : 'x');
    async function fetchFrame(t, fast) {
      const r = await fetch(API + '/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: S.url, t, fast, h: 720 }), signal: abortAll.signal });
      if (!r.ok) throw new Error('frame ' + r.status);
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      const img = new Image();
      img.src = u;
      try { await img.decode(); } finally { URL.revokeObjectURL(u); }
      frames.set(fk(t, fast), img);
      if (frames.size > 40) frames.delete(frames.keys().next().value);
      return img;
    }
    // show the frame at absolute time t: instantly the nearest filmstrip thumb, then the real frame
    function showFrame(t, fast) {
      S.pvT = t;
      if (inProxy(t) && !S.previewing) {
        showVideoMode(); S.frameLoading = false; updateBusy();
        try { pvid.currentTime = clamp(t - basePs, 0, pvid.duration || 1e9); } catch (_) {}
        return;
      }
      showFrameMode();
      const ex = frames.get(fk(t, false)) || (fast && frames.get(fk(t, true)));
      if (ex) { drawImg(ex); S.frameLoading = false; updateBusy(); return; }
      drawPlaceholder(t);
      if (!S.url) return;
      frameWant = { t, fast }; pumpFrame();
    }
    async function pumpFrame() {
      if (frameBusy || !frameWant || closed) return;
      const w = frameWant; frameWant = null; frameBusy = true; S.frameLoading = true; updateBusy();
      try {
        const img = await fetchFrame(w.t, w.fast);
        if (!frameWant) { drawImg(img); S.frameLoading = false; }
      } catch (_) { if (!frameWant) S.frameLoading = false; }
      frameBusy = false; updateBusy();
      if (frameWant) pumpFrame();
    }

    // ----- UI sync -----
    function updateBusy() {
      let msg = '';
      const pct = Math.round((S.px.progress || 0) * 100);
      if (S.px.status === 'error') msg = 'Preview failed: ' + S.px.msg + ' (press Play to retry)';
      else if (S.playWhenReady) msg = 'Preparing preview ' + pct + '%';
      else if (S.frameLoading) msg = 'Loading frame' + ELLIP;
      else if (S.px.status === 'preparing') msg = 'Preparing preview ' + pct + '%';
      elBusy.textContent = msg; elBusy.style.display = msg ? 'block' : 'none';
    }
    function updateScrub(t) {
      if (t == null) t = curT();
      const d = dur(), rel = clamp(t - S.start, 0, d), f = d > 0 ? rel / d : 0;
      elScf.style.width = (f * 100) + '%';
      elSck.style.left = (f * 100) + '%';
      elPt.textContent = fmtTime(rel) + ' / ' + fmtTime(d);
    }
    function updateHeads(t) {
      const D = S.D || S.end, show = !S.parked;
      elPhFull.style.display = show ? 'block' : 'none'; elPhFull.style.left = (t / D * 100) + '%';
      const inZ = show && t >= S.zs && t <= S.ze;
      elPhZoom.style.display = inZ ? 'block' : 'none'; elPhZoom.style.left = zx(t) + '%';
    }
    function updateTag() {
      if (!S.mark) { elTag.style.display = 'none'; return; }
      elTag.style.display = 'block';
      elTag.textContent = (S.mark === 'start' ? 'START FRAME  ' : 'END FRAME  ') + fmtTime(S.mark === 'start' ? S.start : S.end);
    }

    // ----- trim changes: hold that frame, rebuild the preview file in the background -----
    function parkAt(which) {
      stopPreview();
      S.parked = true; S.mark = which;
      cancelProxy();
      showFrame(which === 'end' ? S.end : S.start, true); // fast (nearest keyframe) while dragging
    }
    function settle() { // handle released: exact frame, then prepare the preview file
      if (!S.mark) return;
      showFrame(S.mark === 'end' ? S.end : S.start, false);
      scheduleProxy();
    }
    function cancelProxy() {
      clearTimeout(pxTimer);
      if (S.px.status === 'preparing') {
        pxToken++;
        if (pxId) api('/preview/' + pxId + '/cancel', {}).catch(() => {});
        pxId = null; S.px = { status: 'idle', ps: 0, pe: 0, progress: 0, msg: '' }; S.playWhenReady = false;
        setPlayIcon(); updateBusy();
      } else if (S.px.status === 'error') {
        S.px = { status: 'idle', ps: 0, pe: 0, progress: 0, msg: '' }; updateBusy();
      }
    }
    function scheduleProxy(delay) {
      clearTimeout(pxTimer);
      if (!S.url || S.saving || closed || proxyReady()) return;
      pxTimer = setTimeout(buildProxy, delay == null ? 800 : delay);
    }
    async function buildProxy() {
      if (closed || !S.probe || S.saving || S.px.status === 'preparing' || proxyReady()) return;
      clearTimeout(pxTimer);
      const ps = S.start, pe = S.end, token = ++pxToken, d = dur();
      S.px = { status: 'preparing', ps, pe, progress: 0, msg: '' }; updateBusy();
      try {
        const hh = Math.min(S.probe.height, d > 240 ? 480 : 720), kb = hh >= 720 ? 3200 : 1600;
        const { id } = await api('/preview', { url: S.url, start: ps, end: pe, height: hh, videoKbps: kb, audioIndex: S.audioIndex });
        if (token !== pxToken || closed) { api('/preview/' + id + '/cancel', {}).catch(() => {}); return; }
        pxId = id;
        for (;;) {
          await sleep(400);
          if (token !== pxToken || closed) return;
          const j = await api('/preview/' + id);
          if (token !== pxToken || closed) return;
          S.px.progress = j.progress || 0; updateBusy();
          if (j.status === 'done') break;
          if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || j.status);
        }
        const r = await fetch(API + '/preview/' + id + '/file', { signal: abortAll.signal });
        if (!r.ok) throw new Error('preview file ' + r.status);
        const blob = await r.blob();
        if (token !== pxToken || closed) return;
        api('/preview/' + id + '/cancel', {}).catch(() => {}); // free the helper's copy
        pxId = null;
        const old = pxUrl;
        pxUrl = URL.createObjectURL(blob);
        pvid.src = pxUrl; pvid.load(); basePs = ps;
        if (old) URL.revokeObjectURL(old);
        pxRetried = false;
        S.px = { status: 'ready', ps, pe, progress: 1, msg: '' }; updateBusy();
        if (S.playWhenReady) { S.playWhenReady = false; startVideoPlay(); }
      } catch (e) {
        if (token !== pxToken || closed) return;
        pxId = null;
        if (!pxRetried) { pxRetried = true; S.px = { status: 'idle', ps: 0, pe: 0, progress: 0, msg: '' }; updateBusy(); scheduleProxy(5000); return; } // one quiet retry (rate limit / stale link)
        S.px = { status: 'error', ps, pe, progress: 0, msg: String((e && e.message) || e).slice(0, 80) };
        S.playWhenReady = false; setPlayIcon(); updateBusy();
      }
    }

    // ----- playback (our own <video> playing the preview file) -----
    function stopPreview() {
      const wasWaiting = S.playWhenReady;
      S.playWhenReady = false;
      if (S.previewing) {
        S.previewing = false; cancelAnimationFrame(S.raf);
        try { pvid.pause(); } catch (_) {}
        S.pvT = basePs + pvid.currentTime;
      }
      if (wasWaiting) updateBusy();
      setPlayIcon();
    }
    function tick() {
      if (!S.previewing) return;
      const t = basePs + pvid.currentTime;
      if (t >= S.end - 0.03) return endPlayback();
      updateHeads(t); updateScrub(t);
      S.raf = requestAnimationFrame(tick);
    }
    function startVideoPlay() {
      showVideoMode();
      const d = dur();
      let from = clamp(S.playFrom, 0, d);
      if (from >= d - 0.1) from = 0;
      S.parked = false; S.mark = null; updateTag();
      S.previewing = true; setPlayIcon();
      const go = () => {
        try { pvid.currentTime = (S.start - basePs) + from; } catch (_) {}
        pvid.playbackRate = S.rate;
        const p = pvid.play();
        if (p && p.catch) p.catch(() => { S.previewing = false; setPlayIcon(); });
        S.raf = requestAnimationFrame(tick);
      };
      if (pvid.readyState >= 1) go(); else pvid.addEventListener('loadedmetadata', go, { once: true });
    }
    function pvPlay() {
      if (S.previewing || S.saving) return;
      S.playFrom = S.parked ? 0 : clamp(S.pvT - S.start, 0, dur());
      if (proxyReady()) return startVideoPlay();
      S.playWhenReady = true; setPlayIcon();
      if (S.px.status === 'error') S.px = { status: 'idle', ps: 0, pe: 0, progress: 0, msg: '' };
      if (S.px.status !== 'preparing') buildProxy();
      updateBusy();
    }
    function togglePlay() {
      if (S.previewing || S.playWhenReady) stopPreview(); else pvPlay();
    }
    function endPlayback() { // reached the clip end: park at the clip start
      S.previewing = false; cancelAnimationFrame(S.raf);
      try { pvid.pause(); } catch (_) {}
      S.parked = true; S.mark = null; S.pvT = S.start;
      try { pvid.currentTime = Math.max(0, S.start - basePs); } catch (_) {}
      setPlayIcon(); drawBars();
    }
    pvid.addEventListener('ended', () => { if (S.previewing) endPlayback(); });
    pvid.addEventListener('pause', () => {
      if (S.previewing && !pvid.ended) { S.previewing = false; cancelAnimationFrame(S.raf); S.pvT = basePs + pvid.currentTime; setPlayIcon(); }
    });
    elPlay.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    cv.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    pvid.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });

    // click / drag the clip scrub bar
    let resumeAfterScrub = false;
    drag(elScrub, (ev, first) => {
      const r = elScrub.getBoundingClientRect(), f = clamp((ev.clientX - r.left) / r.width, 0, 1), d = dur(), t = S.start + f * d;
      if (ev === first) { resumeAfterScrub = S.previewing; stopPreview(); }
      S.parked = false; S.mark = null; S.pvT = t;
      if (proxyReady()) { showVideoMode(); try { pvid.currentTime = t - basePs; } catch (_) {} } else showFrame(t, true);
      updateScrub(t); updateHeads(t); updateTag();
    }, () => {
      if (!proxyReady()) showFrame(S.pvT, false);
      if (resumeAfterScrub) { resumeAfterScrub = false; pvPlay(); }
    });

    // ----- volume / speed -----
    function loadVol() {
      let v = null, m = false;
      try { const a = localStorage.getItem('clipper_vol'); if (a != null) v = parseFloat(a); m = localStorage.getItem('clipper_muted') === '1'; } catch (_) {}
      if (!(typeof v === "number" && v >= 0 && v <= 1)) v = clamp(video.volume == null ? 1 : video.volume, 0, 1);
      return { v, m };
    }
    function applyVol() {
      pvid.volume = S.vol; pvid.muted = S.muted || S.vol === 0;
      const eff = pvid.muted ? 0 : S.vol;
      elVf.style.width = (eff * 100) + '%'; elVk.style.left = (eff * 100) + '%';
      elMute.innerHTML = eff === 0 ? VOL_OFF : VOL_ON;
      elMute.title = pvid.muted ? 'Unmute' : 'Mute';
      try { localStorage.setItem('clipper_vol', String(S.vol)); localStorage.setItem('clipper_muted', S.muted ? '1' : '0'); } catch (_) {}
    }
    elMute.addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.muted || S.vol === 0) { S.muted = false; if (S.vol === 0) S.vol = 0.5; } else S.muted = true;
      applyVol();
    });
    drag(elVol, (ev) => {
      const r = elVol.getBoundingClientRect();
      S.vol = clamp((ev.clientX - r.left) / r.width, 0, 1); S.muted = S.vol === 0;
      applyVol();
    });
    function setRate(v) { S.rate = v; pvid.playbackRate = v; pvid.defaultPlaybackRate = v; }

    // ----- expand -----
    function toggleExpand() {
      if (pv.classList.contains('max')) { pv.classList.remove('max'); return; }
      if (shadow.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
      if (document.fullscreenElement) { pv.classList.add('max'); return; } // app is already fullscreen
      pv.requestFullscreen().catch(() => pv.classList.add('max'));
    }
    elFs.addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(); });
    pv.addEventListener('fullscreenchange', () => { if (!shadow.fullscreenElement) S.fsExitAt = Date.now(); });

    // ----- audio track (default = the one Stremio is playing; changeable) -----
    const LANG_NAMES = { eng: 'English', rus: 'Russian', jpn: 'Japanese', spa: 'Spanish', fra: 'French', deu: 'German', ita: 'Italian', por: 'Portuguese', kor: 'Korean', zho: 'Chinese', pol: 'Polish', ukr: 'Ukrainian', hin: 'Hindi', ara: 'Arabic', tur: 'Turkish', swe: 'Swedish', nld: 'Dutch', ces: 'Czech', hun: 'Hungarian', tha: 'Thai', vie: 'Vietnamese', heb: 'Hebrew', fin: 'Finnish', dan: 'Danish', nor: 'Norwegian', ell: 'Greek', ron: 'Romanian', bul: 'Bulgarian', ind: 'Indonesian' };
    const LANG2 = { en: 'eng', ru: 'rus', ja: 'jpn', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ko: 'kor', zh: 'zho', pl: 'pol', uk: 'ukr', hi: 'hin', ar: 'ara', tr: 'tur', sv: 'swe', nl: 'nld', cs: 'ces', hu: 'hun', th: 'tha', vi: 'vie', he: 'heb', fi: 'fin', da: 'dan', no: 'nor', el: 'ell', ro: 'ron', bg: 'bul', id: 'ind' };
    const LANG_ALT = { fre: 'fra', ger: 'deu', chi: 'zho', dut: 'nld', cze: 'ces', gre: 'ell', rum: 'ron' };
    const lang3 = (l) => { l = String(l || '').toLowerCase().split(/[-_]/)[0].trim(); l = LANG2[l] || l; return LANG_ALT[l] || l; };
    function audioLabel(a, i) {
      const name = LANG_NAMES[lang3(a.lang)] || (a.lang ? String(a.lang).toUpperCase() : 'Track ' + (i + 1));
      const ch = a.channels === 6 ? '5.1' : a.channels === 2 ? 'stereo' : a.channels ? a.channels + 'ch' : '';
      const extra = a.title || [(a.codec || '').toUpperCase(), ch].filter(Boolean).join(' ');
      return name + (extra ? ' (' + extra + ')' : '');
    }
    async function preferredAudioLang() {
      try {
        const ctx = await window.services.core.transport.getState('ctx');
        const l = ctx && ctx.profile && ctx.profile.settings && ctx.profile.settings.audioLanguage;
        if (l) return String(l);
      } catch (_) {}
      return 'eng';
    }
    async function pickAudio(list) {
      // 1) the track the player has enabled (if the browser exposes it), 2) Stremio's preferred audio language, 3) the file's default track
      try { const at = video.audioTracks; if (at && at.length === list.length) { for (let i = 0; i < at.length; i++) if (at[i].enabled) return i; } } catch (_) {}
      const bad = /commentary|descriptive|description|visually impaired/i;
      const pref = lang3(await preferredAudioLang());
      const name = LANG_NAMES[pref];
      const hit = list.findIndex((a) => !bad.test(a.title || '') && (lang3(a.lang) === pref || (name && new RegExp(name, 'i').test(a.title || ''))));
      if (hit >= 0) return hit;
      const def = list.findIndex((a) => a.default && !bad.test(a.title || ''));
      return def >= 0 ? def : 0;
    }
    async function setupAudio(list) {
      if (!list.length) return;
      S.audioIndex = await pickAudio(list);
      ddA.setOptions(list.map((a, i) => ({ value: i, label: audioLabel(a, i), sub: '' })));
      ddA.setValue(S.audioIndex);
      const multi = list.length > 1;
      ddA.el.style.display = multi ? '' : 'none'; lblA.style.display = multi ? '' : 'none';
    }
    function onAudioChange() { // the preview file has the audio baked in: rebuild it
      stopPreview(); cancelProxy();
      S.px = { status: 'idle', ps: 0, pe: 0, progress: 0, msg: '' };
      setPlayIcon(); updateBusy();
      scheduleProxy(300);
    }

    // ----- lifecycle -----
    function initPreview() {
      const lv = loadVol(); S.vol = lv.v; S.muted = lv.m;
      elFs.innerHTML = EXPAND_SVG;
      applyVol(); setPlayIcon(); showFrameMode(); drawFromVideo();
    }
    function afterProbe() {
      buildStrip(stripF, 0, S.D || S.end, false); syncZoomStrip(true);
      if (!S.hasFrame) showFrame(S.pvT, false);
      scheduleProxy(600);
    }
    function teardownPreview() {
      closed = true;
      clearTimeout(zTimer); clearTimeout(pxTimer); cancelAnimationFrame(S.raf);
      pxToken++;
      if (pxId) api('/preview/' + pxId + '/cancel', {}).catch(() => {});
      try { abortAll.abort(); } catch (_) {}
      try { pvid.pause(); pvid.removeAttribute('src'); pvid.load(); } catch (_) {}
      if (pxUrl) URL.revokeObjectURL(pxUrl);
      thumbs.forEach((e) => { if (e.url) URL.revokeObjectURL(e.url); });
      thumbs.clear(); tq.length = 0; frames.clear();
    }

    // --- subtitles switch ---
    sw.addEventListener('click', () => {
      S.subOn = !S.subOn; sw.classList.toggle('on', S.subOn);
      ddS.el.style.display = S.subOn && S.subs.length > 1 ? '' : 'none'; checkDirty();
    });

    // --- close / key handling ---
    function close() {
      if (S.job && S.saving) api('/clip/' + S.job + '/cancel', {}).catch(() => {});
      stopPreview();
      cancelAnimationFrame(S.raf);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKeyUp, true);
      teardownPreview();
      host.remove(); window.__clpHost = null;
      try { video.pause(); } catch (_) {}
      active = null;
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (pv.classList.contains('max')) { pv.classList.remove('max'); return; } if (shadow.fullscreenElement || Date.now() - S.fsExitAt < 400) return; if (!dropdowns.some((d) => { const o = d.el.querySelector('.open'); if (o) { d.close(); return true; } })) close(); return; }
      e.stopPropagation();
      if (e.key === ' ' && !(e.composedPath()[0] instanceof HTMLInputElement)) { e.preventDefault(); if (!e.repeat) togglePlay(); }
    };
    const onKeyUp = (e) => e.stopPropagation();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp, true);
    bd.addEventListener('click', () => dropdowns.forEach((d) => d.close()));
    bd.addEventListener('dblclick', (e) => e.stopPropagation());
    $('.clp-x').addEventListener('click', close);
    btnCancel.addEventListener('click', close);

    // Set end point: the preview's current (paused) time becomes the clip end
    $('.clp-setend').addEventListener('click', () => {
      if (S.saving || !S.probe) return;
      const t = curT();
      if (!(t >= S.start + MIN_LEN)) return toast('Pause the preview at a point after the start, then set the end.');
      stopPreview();
      S.end = clamp(t, S.start + MIN_LEN, S.D || Infinity);
      edgeRecenter(); parkAt('end'); refresh(); settle();
    });

    // after a save, any edit puts the panel back into "ready to save a new clip" mode
    const editSig = () => [elTitle.value.trim(), S.start.toFixed(2), S.end.toFixed(2), S.height, S.fps, S.audioIndex, S.subOn ? 'S' + S.subIdx : '-'].join('|');
    function checkDirty() {
      if (S.savedSig && !S.saving && editSig() !== S.savedSig) resetToEdit();
    }
    function resetToEdit() {
      S.savedSig = null;
      r3.innerHTML = '';
      btnCancel.textContent = 'Cancel'; btnSave.disabled = false;
      r3.append(h('span', 'clp-grow'), btnCancel, btnSave);
      elProg.style.display = 'none'; elProgBar.style.width = '0%';
      setStatus('');
    }

    // --- save ---
    btnSave.addEventListener('click', async () => {
      if (S.saving || !S.probe) return;
      stopPreview(); cancelProxy();
      S.saving = true;
      [btnSave, ddQ, ddF, ddS, ddA].forEach((x) => (x.disabled !== undefined ? (x.disabled = true) : x.disable && x.disable(true)));
      btnSave.disabled = true; elTitle.disabled = elTs.disabled = elTe.disabled = true;
      btnCancel.textContent = 'Cancel save';
      elProg.style.display = ''; elProgBar.style.width = '0%';
      setStatus('Encoding clip' + ELLIP);
      const sub = S.subOn && S.subs[S.subIdx] ? S.subs[S.subIdx] : null;
      try {
        const { id } = await api('/clip', {
          url: S.url, start: S.start, end: S.end, title: elTitle.value.trim() || 'Clip', stamp: elTitle.value.trim() === S.defTitle,
          height: S.height, fps: S.fps, srcFps: S.probe.fps, videoKbps: kbpsFor(S.height, S.fps),
          audioIndex: S.audioIndex, subtitle: sub ? { type: sub.type, url: sub.url, index: sub.index, codec: sub.codec } : null
        });
        S.job = id;
        for (;;) {
          await sleep(500);
          if (!active) return;
          const j = await api('/clip/' + id);
          elProgBar.style.width = Math.round(j.progress * 100) + '%';
          if (j.status === 'done') {
            S.saving = false;
            elProgBar.style.width = '100%';
            setStatus('Saved ' + CHECK + ' ' + j.name + ' (' + fmtSize(j.size || 0) + ')' + (j.notes && j.notes.length ? ' ' + DASH + ' ' + j.notes.join(' ') : ''));
            r3.innerHTML = '';
            const bo = h('button', 'clp-btn', 'Open folder'), bc = h('button', 'clp-btn', 'Copy file'), bx = h('button', 'clp-btn primary', 'Close');
            bo.onclick = () => api('/open-folder', { file: j.file }).catch(() => {});
            bc.onclick = async () => { try { await api('/copy-file', { file: j.file }); bc.textContent = 'Copied ' + CHECK; } catch (_) { bc.textContent = 'Copy failed'; } };
            bx.onclick = close;
            r3.append(h('span', 'clp-grow'), bo, bc, bx);
            elTitle.disabled = elTs.disabled = elTe.disabled = false;
            ddQ.disable(false); ddF.disable(false); ddS.disable(false); ddA.disable(false);
            S.savedSig = editSig();
            scheduleProxy(300);
            return;
          }
          if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || j.status);
        }
      } catch (e) {
        S.saving = false;
        if (!active) return;
        setStatus('Save failed: ' + (e.message || e), true);
        elProg.style.display = 'none'; btnCancel.textContent = 'Cancel';
        btnSave.disabled = false; elTitle.disabled = elTs.disabled = elTe.disabled = false;
        ddQ.disable(false); ddF.disable(false); ddS.disable(false); ddA.disable(false);
      }
    });

    // --- load state + probe ---
    recenter(); drawBars(); initPreview();
    (async () => {
      const state = await getPlayerState();
      S.state = state;
      elTitle.value = defaultTitle(state); S.defTitle = elTitle.value;
      try {
        if (localStorage.getItem('clipper_debug') === '1') api('/debug', { state, src: video.currentSrc, origin: location.origin, href: location.href }).catch(() => {});
      } catch (_) {}
      const urls = resolveStreamUrls(state, video);
      let probe = null, lastErr = '';
      for (const u of urls) {
        try { probe = await api('/probe', { url: u }, 60000); S.url = u; break; } catch (e) { lastErr = e.message || String(e); }
      }
      if (!active) return;
      if (!probe) {
        return setStatus(urls.length ? 'Could not read this stream: ' + lastErr : 'Could not find the stream URL for this video.', true);
      }
      S.probe = probe;
      if (!S.D) { S.D = probe.duration || S.end; recenter(); }
      S.height = probe.height; S.fps = probe.fps;
      S.qualityList = QUALITIES.filter((q) => q < probe.height); S.qualityList.unshift(probe.height);
      S.fpsList = FPS_OPTIONS.filter((f) => f < probe.fps - 0.5); S.fpsList.unshift(probe.fps);
      // subtitles: addon (external) first, then embedded
      S.subs = collectExternalSubs(state).concat((probe.subtitles || []).map((s) => ({ type: 'embedded', index: s.index, codec: s.codec, lang: s.lang || '', label: s.title })));
      if (S.subs.length) {
        // prefer a full English track; skip "Signs & Songs", forced, and commentary tracks
        const text = (s) => (s.label || '') + ' ' + (s.lang || '');
        const good = S.subs.map((s, i) => i).filter((i) => !/signs|songs|forced|commentary/i.test(text(S.subs[i])));
        const pool = good.length ? good : S.subs.map((s, i) => i);
        const en = pool.find((i) => /(^|\s)(en|eng|english)/i.test(text(S.subs[i])));
        S.subIdx = en != null ? en : pool[0];
        ddS.setOptions(S.subs.map((s, i) => ({ value: i, label: (s.label || s.lang || 'Track ' + (i + 1)) + (s.type === 'embedded' ? ' (embedded)' : ''), sub: '' })));
        ddS.setValue(S.subIdx);
        sw.classList.remove('dis');
        
      } else { sw.title = 'No subtitle tracks available for this stream'; }
      await setupAudio(probe.audio || []);
      setStatus('');
      btnSave.disabled = false;
      afterProbe();
      refresh();
    })();
  }

  /* ---------- button injection ---------- */
  const BAR_SELECTORS = [
    '.control-bar-buttons-menu-container-M6L0_',
    "[class*='control-bar-buttons']",
    "[class*='control-bar'] [class*='buttons']",
    ".control-bar-container-xsWA7 [class*='buttons']"
  ];
  const ICON = '<svg class="icon-qy6I6 custom-icon" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88"/><path d="M14.47 14.48 20 20"/><path d="M8.12 8.12 12 12"/></svg>';

  function addButton() {
    if (!location.hash.includes('#/player')) return;
    let bar = null;
    for (const s of BAR_SELECTORS) { bar = document.querySelector(s); if (bar) break; }
    if (!bar || bar.querySelector('.' + BTN_CLASS)) return;
    const b = document.createElement('div');
    b.tabIndex = -1;
    b.title = 'Clip';
    b.className = 'control-bar-button-FQUsj button-container-zVLH6 ' + BTN_CLASS;
    b.style.display = 'flex'; b.style.alignItems = 'center'; b.style.justifyContent = 'center';
    b.innerHTML = ICON;
    b.addEventListener('click', (e) => { e.stopPropagation(); openEditor(); });
    b.addEventListener('mouseenter', () => (b.style.opacity = '0.8'));
    b.addEventListener('mouseleave', () => (b.style.opacity = '1'));
    bar.insertAdjacentElement('afterbegin', b);
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; addButton(); });
  }).observe(document.body, { childList: true, subtree: true });
  setTimeout(addButton, 500);

  // leaving the player closes any open editor
  window.addEventListener('hashchange', () => {
    if (active && !location.hash.includes('#/player')) {
      window.__clpHost && window.__clpHost.shadowRoot.querySelector('.clp-x').click();
    }
  });
})();
