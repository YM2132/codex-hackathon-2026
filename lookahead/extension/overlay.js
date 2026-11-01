/* Live look-ahead preview. MAIN world, after page-hook.js.
 *
 * Keeps ONE hidden decoder (<video> + MediaSource) per captured video SourceBuffer and
 * feeds it only the chunks it hasn't seen yet. Every tick it seeks the hidden decoder to
 * (playhead + N seconds) and paints that frame into a small panel. YouTube's own player
 * is only ever read (currentTime), never touched.
 * DOM is built with createElement/textContent only (YouTube enforces Trusted Types).
 */
(() => {
  if (window.__lookaheadOverlay) return;
  window.__lookaheadOverlay = true;
  const L = () => window.__lookahead?._internal;

  let aheadSec = 5;
  let dec = null;       // { rec, video, ms, sb, lastSeq, busy, url }
  let seeking = false;
  const fmt = (t) => !Number.isFinite(t) ? '--' : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

  // ---------- UI ----------
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; };
  const host = el('div', 'position:fixed;top:72px;right:16px;z-index:2147483647;');
  const root = host.attachShadow({ mode: 'open' });
  const panel = el('div', 'width:340px;background:#111c;color:#fff;font:12px/1.4 system-ui,sans-serif;border-radius:10px;padding:10px;box-shadow:0 6px 24px #0008;backdrop-filter:blur(6px);');
  const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;');
  const title = el('b', 'font-size:13px;', 'Look-ahead preview');
  const btns = el('div', 'display:flex;gap:4px;');
  const mkBtn = (label, fn) => { const b = el('button', 'background:#333;color:#fff;border:1px solid #555;border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit;', label); b.onclick = fn; btns.append(b); return b; };
  const aheadBtns = [3, 5, 10].map(s => mkBtn(`+${s}s`, () => { aheadSec = s; paintButtons(); }));
  mkBtn('×', () => { host.remove(); });
  const paintButtons = () => aheadBtns.forEach((b, i) => b.style.background = [3, 5, 10][i] === aheadSec ? '#c00' : '#333');
  paintButtons();
  head.append(title, btns);
  const canvas = el('canvas', 'width:100%;aspect-ratio:16/9;background:#000;border-radius:6px;display:block;');
  canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const label = el('div', 'margin-top:6px;font-variant-numeric:tabular-nums;');
  const bar = el('div', 'position:relative;height:8px;background:#333;border-radius:4px;margin-top:6px;overflow:hidden;');
  const barBuf = el('div', 'position:absolute;top:0;bottom:0;background:#666;');
  const barPlay = el('div', 'position:absolute;top:-2px;bottom:-2px;width:2px;background:#fff;');
  const barPrev = el('div', 'position:absolute;top:-2px;bottom:-2px;width:3px;background:#f33;');
  bar.append(barBuf, barPlay, barPrev);
  const legend = el('div', 'margin-top:4px;color:#aaa;font-size:11px;', 'white = playhead · red = previewed frame · grey = buffered (window ±40s)');
  const stats = el('div', 'margin-top:4px;color:#8a8;font-size:11px;font-variant-numeric:tabular-nums;');
  panel.append(head, canvas, label, bar, legend, stats);
  root.append(panel);

  const mount = () => { if (!host.isConnected && document.body && location.pathname === '/watch') document.body.append(host); };

  // ---------- decoder ----------
  function teardown() {
    if (!dec) return;
    try { URL.revokeObjectURL(dec.url); dec.video.removeAttribute('src'); dec.video.load(); } catch (_) {}
    dec = null;
  }
  function build(rec) {
    teardown();
    const video = document.createElement('video');
    video.__lookaheadDecoder = true; video.muted = true; video.preload = 'auto';
    const ms = new MediaSource(); const url = URL.createObjectURL(ms);
    dec = { rec, video, ms, sb: null, lastSeq: -1, busy: false, url, bytesFed: 0 };
    const d = dec;
    ms.addEventListener('sourceopen', () => {
      if (dec !== d) return;
      d.sb = Reflect.apply(L().nativeAddSourceBuffer, ms, [rec.mime]);
    }, { once: true });
    video.src = url;
  }
  const waitUpdate = (sb) => new Promise((res, rej) => {
    sb.addEventListener('updateend', res, { once: true });
    sb.addEventListener('error', () => rej(new Error('sb error')), { once: true });
  });
  // Feed only chunks with seq > lastSeq; evict old decoded data to bound memory.
  async function feed(playhead) {
    const d = dec; if (!d || !d.sb || d.busy || d.sb.updating) return;
    d.busy = true;
    try {
      const chunks = d.rec.chunks;
      // Start from the first init segment the first time.
      if (d.lastSeq < 0) { const i = chunks.findIndex(c => c.init); if (i < 0) return; d.lastSeq = chunks[i].seq - 1; }
      for (const c of chunks) {
        if (c.seq <= d.lastSeq) continue;
        if (dec !== d) return;
        if (!c.init && d.sb.mode !== c.mode) d.sb.mode = c.mode;
        if (d.sb.timestampOffset !== c.tso) d.sb.timestampOffset = c.tso;
        try {
          Reflect.apply(L().nativeAppend, d.sb, [c.bytes]);
          await waitUpdate(d.sb);
        } catch (e) {
          if (e.name === 'QuotaExceededError') { await evict(d, playhead, 5); continue; }
          throw e;
        }
        d.lastSeq = c.seq; d.bytesFed += c.bytes.byteLength;
      }
      await evict(d, playhead, 30);
    } catch (e) { console.warn('[lookahead] feed error, rebuilding', e); build(d.rec); }
    finally { d.busy = false; }
  }
  async function evict(d, playhead, keepBehind) {
    const r = L().ranges(d.sb.buffered);
    if (r.length && r[0][0] < playhead - keepBehind - 5 && !d.sb.updating) {
      Reflect.apply(L().nativeRemove, d.sb, [0, playhead - keepBehind]);
      await waitUpdate(d.sb);
    }
  }

  // ---------- tick ----------
  async function tick() {
    mount();
    const api = L(); if (!api || !host.isConnected) return;
    const main = api.mainVideo(); const rec = api.activeRecord();
    if (!main || !rec) { label.textContent = 'Waiting for YouTube to buffer video…'; return; }
    if (!dec || dec.rec !== rec) build(rec);   // new video / new MediaSource (SPA nav, ads)
    const playhead = main.currentTime;
    await feed(playhead);
    const target = playhead + aheadSec;
    const db = dec?.sb ? api.ranges(dec.sb.buffered) : [];
    const mb = api.ranges(main.buffered);
    const bufEnd = (mb.find(([s, e]) => s <= playhead + 0.05 && e >= playhead) || [0, playhead])[1];
    // timeline
    const w0 = playhead - 10, span = 50, pct = (t) => `${Math.max(0, Math.min(100, (t - w0) / span * 100))}%`;
    barBuf.style.left = pct(playhead); barBuf.style.width = `calc(${pct(bufEnd)} - ${pct(playhead)})`;
    barPlay.style.left = pct(playhead); barPrev.style.left = pct(target);
    stats.textContent = `buffered ahead: ${(bufEnd - playhead).toFixed(1)}s · captured ${(rec.bytes / 1e6).toFixed(2)} MB (${rec.mime.split(';')[1]?.trim() || rec.mime}) · decoder fed ${(dec.bytesFed / 1e6).toFixed(2)} MB`;
    if (!db.some(([s, e]) => target >= s && target < e - 0.05)) {
      label.textContent = `Playhead ${fmt(playhead)} → ${fmt(target)} not buffered yet`;
      return;
    }
    if (seeking) return;
    seeking = true;
    try {
      const v = dec.video;
      const t0 = performance.now();
      v.currentTime = target;
      await new Promise((res) => { const to = setTimeout(res, 1500); v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true }); });
      if (v.readyState >= 2 && v.videoWidth) {
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        label.textContent = `Frame @ ${fmt(v.currentTime)}  ·  playhead ${fmt(playhead)}  ·  +${(v.currentTime - playhead).toFixed(1)}s ahead  ·  ${Math.round(performance.now() - t0)} ms`;
      }
    } finally { seeking = false; }
  }
  setInterval(() => { tick().catch(e => console.warn('[lookahead]', e)); }, 400);
})();
