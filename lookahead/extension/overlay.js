/* Live look-ahead preview for any page. MAIN world, after page-hook.js, in every frame.
 *
 * Picks the video the viewer is watching and keeps a hidden decoder for it:
 *  - MSE source:         separate MediaSource fed only with captured chunks it hasn't seen.
 *  - Progressive source: a second <video> on the same file URL (independent seek).
 * Every tick it seeks the hidden decoder to playhead + N s and paints that frame.
 * The page's own player is only read, never touched. DOM built without innerHTML
 * (Trusted Types sites such as YouTube reject it).
 */
(() => {
  if (window.__lookaheadOverlay || !window.__lookahead) return;
  window.__lookaheadOverlay = true;
  const api = window.__lookahead._internal;

  let aheadSec = 5, closed = false;
  let dec = null;       // { key, kind, rec?, video, sb?, lastSeq, busy, bytesFed }
  let seeking = false;
  const fmt = (t) => !Number.isFinite(t) ? '--' : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const KIND_TEXT = {
    mse: 'MSE capture', progressive: 'file URL (second decoder)',
    drm: 'DRM-protected (EME): frames cannot be decoded outside the player',
    'worker-mse': 'MSE runs in a worker: not capturable yet',
    'blob-unknown': 'blob source not created through MSE hook', 'mse-pending': 'waiting for first segments…',
    stream: 'live MediaStream (camera/WebRTC): nothing buffered ahead',
  };

  // ---------- UI ----------
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; };
  const host = el('div', 'position:fixed;top:72px;right:16px;z-index:2147483647;display:none;');
  const root = host.attachShadow({ mode: 'closed' });
  const panel = el('div', 'width:340px;max-width:42vw;min-width:200px;background:#111d;color:#fff;font:12px/1.4 system-ui,sans-serif;border-radius:10px;padding:10px;box-shadow:0 6px 24px #0008;');
  const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;');
  const title = el('b', 'font-size:13px;white-space:nowrap;', 'Look-ahead preview');
  const btns = el('div', 'display:flex;gap:4px;');
  const mkBtn = (label, fn) => { const b = el('button', 'background:#333;color:#fff;border:1px solid #555;border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit;', label); b.onclick = fn; btns.append(b); return b; };
  const aheadBtns = [3, 5, 10].map(s => mkBtn(`+${s}s`, () => { aheadSec = s; paintButtons(); }));
  mkBtn('×', () => { closed = true; host.remove(); });
  const paintButtons = () => aheadBtns.forEach((b, i) => b.style.background = [3, 5, 10][i] === aheadSec ? '#c00' : '#333');
  paintButtons();
  head.append(title, btns);
  const canvas = el('canvas', 'width:100%;aspect-ratio:16/9;background:#000;border-radius:6px;display:block;object-fit:contain;');
  canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const label = el('div', 'margin-top:6px;font-variant-numeric:tabular-nums;');
  const bar = el('div', 'position:relative;height:8px;background:#333;border-radius:4px;margin-top:6px;overflow:hidden;');
  const barBuf = el('div', 'position:absolute;top:0;bottom:0;background:#666;');
  const barPlay = el('div', 'position:absolute;top:-2px;bottom:-2px;width:2px;background:#fff;');
  const barPrev = el('div', 'position:absolute;top:-2px;bottom:-2px;width:3px;background:#f33;');
  bar.append(barBuf, barPlay, barPrev);
  const legend = el('div', 'margin-top:4px;color:#aaa;font-size:11px;', 'white = playhead · red = previewed frame · grey = buffered');
  const stats = el('div', 'margin-top:4px;color:#8a8;font-size:11px;font-variant-numeric:tabular-nums;');
  panel.append(head, canvas, label, bar, legend, stats);
  root.append(panel);
  // Test hook: harness reads status without piercing the closed shadow root.
  Object.defineProperty(window, '__lookaheadStatus', { value: () => ({ label: label.textContent, stats: stats.textContent, shown: host.style.display !== 'none' && host.isConnected }) });

  // In fullscreen, the panel must live inside the fullscreen element to stay visible.
  const mount = () => {
    if (closed) return;
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : (document.body || document.documentElement);
    if (parent && host.parentNode !== parent) parent.append(host);
  };
  document.addEventListener('fullscreenchange', mount);

  // ---------- decoder ----------
  function teardown() {
    if (!dec) return;
    try { if (dec.url) URL.revokeObjectURL(dec.url); dec.video.removeAttribute('src'); dec.video.load(); } catch (_) {}
    dec = null;
  }
  function buildMse(rec) {
    teardown();
    const video = document.createElement('video');
    video.__lookaheadDecoder = true; video.muted = true; video.preload = 'auto';
    const ms = new MediaSource(); const url = api.createObjectURL(ms);
    const d = dec = { key: rec, kind: 'mse', rec, video, sb: null, lastSeq: -1, busy: false, url, bytesFed: 0 };
    ms.addEventListener('sourceopen', () => { if (dec === d) d.sb = Reflect.apply(api.nativeAddSourceBuffer, ms, [rec.mime]); }, { once: true });
    video.src = url;
  }
  function buildProgressive(url) {
    teardown();
    const video = document.createElement('video');
    video.__lookaheadDecoder = true; video.muted = true; video.preload = 'auto';
    video.src = url;
    dec = { key: url, kind: 'progressive', video, bytesFed: 0 };
  }
  const waitUpdate = (sb) => new Promise((res, rej) => {
    sb.addEventListener('updateend', res, { once: true });
    sb.addEventListener('error', () => rej(new Error('sb error')), { once: true });
  });
  async function feed(playhead) {
    const d = dec; if (!d || d.kind !== 'mse' || !d.sb || d.busy || d.sb.updating) return;
    d.busy = true;
    try {
      const chunks = d.rec.chunks;
      if (d.lastSeq < 0) { const first = chunks.find(c => c.init); if (!first) return; d.lastSeq = first.seq - 1; }
      for (const c of chunks) {
        if (c.seq <= d.lastSeq) continue;
        if (dec !== d) return;
        try { await api.replayChunk(d.sb, c); }
        catch (e) {
          if (e.name === 'QuotaExceededError') { await evict(d, playhead, 5); break; }
          throw e;
        }
        d.lastSeq = c.seq; d.bytesFed += c.bytes.byteLength;
      }
      await evict(d, playhead, 30);
      api.prune(d.rec, playhead - 40);       // captured chunks far behind the playhead are no longer needed
    } catch (e) { console.warn('[lookahead] feed error, rebuilding', e); buildMse(d.rec); }
    finally { d.busy = false; }
  }
  async function evict(d, playhead, keepBehind) {
    const r = api.ranges(d.sb.buffered);
    if (r.length && r[0][0] < playhead - keepBehind - 5 && !d.sb.updating) {
      Reflect.apply(api.nativeRemove, d.sb, [0, playhead - keepBehind]);
      await waitUpdate(d.sb);
    }
  }

  // ---------- tick ----------
  async function tick() {
    if (closed) return;
    const main = api.pickVideo();
    const src = api.classify(main);
    // Only show the panel when there is a real video on screen in this frame.
    if (!main || src.kind === 'none' || (main.currentTime === 0 && main.paused)) { host.style.display = 'none'; return; }
    mount(); host.style.display = '';
    if (src.kind === 'mse') { if (!dec || dec.key !== src.rec) buildMse(src.rec); }
    else if (src.kind === 'progressive') { if (!dec || dec.key !== src.url) buildProgressive(src.url); }
    else { teardown(); label.textContent = KIND_TEXT[src.kind] || src.kind; stats.textContent = ''; ctx.clearRect(0, 0, canvas.width, canvas.height); return; }

    const playhead = main.currentTime;
    await feed(playhead);
    const target = playhead + aheadSec;
    const db = dec.kind === 'mse' ? (dec.sb ? api.ranges(dec.sb.buffered) : []) : api.ranges(dec.video.seekable);
    const mb = api.ranges(main.buffered);
    const bufEnd = (mb.find(([s, e]) => s <= playhead + 0.05 && e >= playhead) || [0, playhead])[1];
    const w0 = playhead - 10, span = 50, pct = (t) => `${Math.max(0, Math.min(100, (t - w0) / span * 100))}%`;
    barBuf.style.left = pct(playhead); barBuf.style.width = `calc(${pct(bufEnd)} - ${pct(playhead)})`;
    barPlay.style.left = pct(playhead); barPrev.style.left = pct(target);
    stats.textContent = `${KIND_TEXT[dec.kind]} · buffered ahead ${(bufEnd - playhead).toFixed(1)}s` +
      (dec.kind === 'mse' ? ` · ${(dec.rec.mime.match(/codecs="?([^",]+)/) || [, dec.rec.mime])[1]} · fed ${(dec.bytesFed / 1e6).toFixed(2)} MB` : '') +
      ` · ${location.hostname}`;
    let seekTo = target, clamped = false;
    if (!db.some(([s, e]) => target >= s && target < e - 0.05)) {
      // Player buffers less than requested: show the furthest frame we do have, if it's ahead.
      const cover = db.find(([s, e]) => s <= playhead + 0.05 && e > playhead + 0.3);
      if (!cover) { label.textContent = `Playhead ${fmt(playhead)} → ${fmt(target)} not buffered yet`; return; }
      seekTo = cover[1] - 0.1; clamped = true;
    }
    barPrev.style.left = pct(seekTo);
    if (seeking) return;
    seeking = true;
    try {
      const v = dec.video, t0 = performance.now();
      v.currentTime = seekTo;
      // Progressive files may need a network range request per seek: allow longer, say so.
      if (dec.kind === 'progressive' && v.readyState < 2) label.textContent = `Fetching frame @ ${fmt(seekTo)}…`;
      await new Promise((res) => { const to = setTimeout(res, dec.kind === 'progressive' ? 10000 : 2000); v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true }); });
      if (v.readyState >= 2 && v.videoWidth) {
        // letterbox into the 16:9 canvas
        const s = Math.min(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
        const w = v.videoWidth * s, h = v.videoHeight * s;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(v, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        label.textContent = `Frame @ ${fmt(v.currentTime)}  ·  playhead ${fmt(playhead)}  ·  +${(v.currentTime - playhead).toFixed(1)}s ahead${clamped ? ' (max buffered)' : ''}  ·  ${Math.round(performance.now() - t0)} ms`;
      }
    } finally { seeking = false; }
  }
  setInterval(() => { tick().catch(e => console.warn('[lookahead]', e)); }, 400);
})();
