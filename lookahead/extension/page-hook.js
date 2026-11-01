/* Look-ahead capture hook. Runs in the page's MAIN world at document_start (every supported site).
 *
 *  - Wraps MediaSource.addSourceBuffer / SourceBuffer.appendBuffer / changeType and keeps a COPY
 *    of every encoded chunk a page hands to MSE, with the MIME type in force for that chunk,
 *    timestampOffset, append mode and the time range it added. The caller's buffer is untouched.
 *  - Maps each <video> to the MediaSource feeding it (URL.createObjectURL / srcObject), including
 *    players inside shadow DOM, so pages with several players (feeds) work.
 *  - Classifies each video's source: 'mse' (capturable), 'progressive' (plain file URL),
 *    'drm' (encrypted stream), 'worker-mse' (MediaSourceHandle, not visible here).
 *  - decodeFuture(): replays captured bytes into a separate hidden MediaSource + <video> (or, for a
 *    plain file, a second <video> on the same URL) and returns JPEG frames. The page's own player
 *    is never seeked.
 *  - Announces the watched video to the isolated world with a composed 'pawse-main-video' event,
 *    so the Pawse controller can reach players inside open shadow roots.
 *  - Window-message bridge: {tag:"lookahead-req", id, op, args} -> {tag:"lookahead-res", id, result, error}.
 */
(() => {
  if (window.__lookahead || typeof MediaSource === 'undefined') return;

  const MAX_BYTES_PER_SB = 64 * 1024 * 1024;
  const native = {
    addSourceBuffer: MediaSource.prototype.addSourceBuffer,
    appendBuffer: SourceBuffer.prototype.appendBuffer,
    remove: SourceBuffer.prototype.remove,
    changeType: SourceBuffer.prototype.changeType,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
    srcObjectDesc: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject'),
    srcDesc: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src'),
  };
  const nativeCreateObjectURL = (o) => Reflect.apply(native.createObjectURL, URL, [o]);

  let nextMsId = 1, nextSbId = 1;
  const msIds = new WeakMap();           // MediaSource -> id
  const mediaUrls = new Map();           // blob: URL -> MediaSource id
  const sbInfo = new WeakMap();          // SourceBuffer -> record
  const sourceBuffers = [];              // records, in creation order
  const handleVideos = new WeakSet();    // videos fed by a worker MediaSourceHandle
  const knownVideos = new Set();         // videos whose src/srcObject the page set (covers shadow DOM)
  const diag = { workersCreated: 0, mediaSourceHandleAttached: false, hookErrors: [],
    workerMseSupported: !!MediaSource.canConstructInDedicatedWorker };
  const msId = (ms) => { if (!msIds.has(ms)) msIds.set(ms, nextMsId++); return msIds.get(ms); };
  const isDecoder = (v) => !!v.__lookaheadDecoder;

  const toU8Copy = (data) => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return null;
  };
  const ranges = (tr) => { const r = []; try { for (let i = 0; i < tr.length; i++) r.push([tr.start(i), tr.end(i)]); } catch (_) {} return r; };
  const looksLikeInit = (u8) => {
    if (u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'webm';
    if (u8.length >= 8) {
      const box = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
      if (box === 'ftyp' || box === 'moov') return 'mp4';
    }
    return null;
  };
  // Time range newly covered after an append = after minus before.
  const addedRange = (before, after) => {
    let lo = Infinity, hi = -Infinity;
    for (const [s, e] of after) {
      if (before.some(([bs, be]) => bs <= s + 0.01 && be >= e - 0.01)) continue;
      let ns = s, ne = e;
      for (const [bs, be] of before) {
        if (bs <= ns + 0.01 && be > ns) ns = be;
        if (be >= ne - 0.01 && bs < ne) ne = bs;
      }
      if (ne > ns) { lo = Math.min(lo, ns); hi = Math.max(hi, ne); }
    }
    return Number.isFinite(lo) ? [lo, hi] : null;
  };

  const wrap = (name, fn) => { try { fn(); } catch (e) { diag.hookErrors.push(`${name}: ${e}`); } };

  wrap('createObjectURL', () => {
    URL.createObjectURL = function (obj) {
      const url = Reflect.apply(native.createObjectURL, this, [obj]);
      if (obj instanceof MediaSource) mediaUrls.set(url, msId(obj));
      return url;
    };
  });

  wrap('addSourceBuffer', () => {
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = Reflect.apply(native.addSourceBuffer, this, [mime]);
      const rec = { id: nextSbId++, msId: msId(this), mime: String(mime), createdAt: performance.now(),
        chunks: [], bytes: 0, droppedBytes: 0, appends: 0, nextSeq: 0 };
      sbInfo.set(sb, rec);
      sourceBuffers.push(rec);
      return sb;
    };
  });

  wrap('appendBuffer', () => {
    SourceBuffer.prototype.appendBuffer = function (data) {
      const rec = sbInfo.get(this);
      if (rec) {
        try {
          const copy = toU8Copy(data);
          if (copy) {
            const before = ranges(this.buffered);
            const chunk = { seq: rec.nextSeq++, at: performance.now(), tso: this.timestampOffset, mime: rec.mime,
              mode: this.mode, init: looksLikeInit(copy), bytes: copy, added: null };
            rec.chunks.push(chunk); rec.bytes += copy.byteLength; rec.appends++;
            const sb = this;
            sb.addEventListener('updateend', () => { chunk.added = addedRange(before, ranges(sb.buffered)); }, { once: true });
            while (rec.bytes > MAX_BYTES_PER_SB) {           // memory cap: drop oldest media chunks
              const idx = rec.chunks.findIndex(c => !c.init);
              if (idx < 0) break;
              const [old] = rec.chunks.splice(idx, 1);
              rec.bytes -= old.bytes.byteLength; rec.droppedBytes += old.bytes.byteLength;
            }
          }
        } catch (e) { diag.hookErrors.push('append copy: ' + e); }
      }
      return Reflect.apply(native.appendBuffer, this, [data]);
    };
  });

  // YouTube can create a VP9/WebM buffer, then switch it to AV1/MP4 before appending.
  // Each chunk records the MIME in force when it was appended, so replay can follow the switch.
  if (native.changeType) wrap('changeType', () => {
    SourceBuffer.prototype.changeType = function (mime) {
      const result = Reflect.apply(native.changeType, this, [mime]);
      const rec = sbInfo.get(this);
      if (rec) rec.mime = String(mime);
      return result;
    };
  });

  // Paths we can't capture from the main thread: detect them so the UI can say so.
  wrap('Worker', () => {
    const NativeWorker = window.Worker;
    if (NativeWorker) window.Worker = new Proxy(NativeWorker, { construct(t, a, nt) { diag.workersCreated++; return Reflect.construct(t, a, nt); } });
  });
  if (native.srcObjectDesc?.set) wrap('srcObject', () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      ...native.srcObjectDesc,
      set(v) {
        if (window.MediaSourceHandle && v instanceof MediaSourceHandle) { diag.mediaSourceHandleAttached = true; handleVideos.add(this); }
        if (v && this instanceof HTMLVideoElement && !isDecoder(this)) knownVideos.add(this);
        return native.srcObjectDesc.set.call(this, v);
      },
    });
  });
  // Videos inside shadow DOM (e.g. Reddit's player) are invisible to querySelectorAll.
  if (native.srcDesc?.set) wrap('src', () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...native.srcDesc,
      set(v) { if (this instanceof HTMLVideoElement && !isDecoder(this)) knownVideos.add(this); return native.srcDesc.set.call(this, v); },
    });
  });

  // ---------- video <-> source mapping ----------
  const allVideos = () => {
    const set = new Set(document.querySelectorAll('video'));
    for (const v of knownVideos) { if (v.isConnected) set.add(v); else knownVideos.delete(v); }
    return [...set].filter(v => !isDecoder(v));
  };
  function msOfVideo(v) {
    const so = native.srcObjectDesc?.get?.call(v);
    if (so instanceof MediaSource) return msId(so);
    const src = v.currentSrc || v.src;
    return src && src.startsWith('blob:') ? (mediaUrls.get(src) ?? null) : null;
  }
  // Only the MediaSource actually attached to this video counts: never decode another player's bytes.
  function recordForVideo(v) {
    if (!v) return null;
    const id = msOfVideo(v);
    if (id == null) return null;
    return sourceBuffers.filter(r => r.msId === id && r.mime.startsWith('video/') && r.appends > 0).pop() || null;
  }
  // Real encryption markers in the header part of an init segment (before any media data):
  // MP4 'encv'/'enca'/'tenc' boxes inside moov; WebM ContentEncodings (6D 80) + ContentEncryption (50 35).
  const find = (u8, seq, end = u8.length) => { outer: for (let i = 0; i + seq.length <= end; i++) { for (let j = 0; j < seq.length; j++) if (u8[i + j] !== seq[j]) continue outer; return i; } return -1; };
  const bytesOf = (s) => [...s].map(ch => ch.charCodeAt(0));
  const headerEnd = (u8, markers) => Math.min(...markers.map(m => { const i = find(u8, m); return i < 0 ? u8.length : i; }));
  const isEncrypted = (rec) => rec.chunks.some(c => {
    if (c.init === 'mp4') {
      const end = headerEnd(c.bytes, [bytesOf('moof'), bytesOf('mdat')]);
      return ['encv', 'enca', 'tenc'].some(b => find(c.bytes, bytesOf(b), end) >= 0);
    }
    if (c.init === 'webm') {
      const end = headerEnd(c.bytes, [[0x1f, 0x43, 0xb6, 0x75]]);   // first Cluster
      return find(c.bytes, [0x6d, 0x80], end) >= 0 && find(c.bytes, [0x50, 0x35], end) >= 0;
    }
    return false;
  });
  function classify(v) {
    if (!v) return { kind: 'none' };
    if (handleVideos.has(v)) return { kind: 'worker-mse' };
    const rec = recordForVideo(v);
    // Some players (e.g. Vimeo) attach MediaKeys even to clear streams, so check the bytes.
    if (rec) return (rec.encrypted ?? (rec.encrypted = isEncrypted(rec))) ? { kind: 'drm' } : { kind: 'mse', rec };
    if (v.mediaKeys) return { kind: 'drm' };
    const src = v.currentSrc || v.src || '';
    if (/^(https?|data):/.test(src)) return { kind: 'progressive', url: src };
    if (src.startsWith('blob:')) return { kind: mediaUrls.has(src) ? 'mse-pending' : 'blob-unknown' };
    if (native.srcObjectDesc?.get?.call(v)) return { kind: 'stream' };
    return { kind: 'none' };
  }
  // The video a viewer is most likely watching: playing > started > largest on screen.
  function pickVideo() {
    let best = null, bestScore = -1;
    for (const v of allVideos()) {
      const r = v.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (area < 120 * 68 || v.readyState === 0) continue;
      const score = area * (v.paused ? 1 : 4) * (v.currentTime > 0 ? 2 : 1);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }
  const mainVideo = pickVideo;

  function playerState(v = pickVideo()) {
    if (!v) return { hasVideo: false };
    const buffered = ranges(v.buffered);
    const cur = v.currentTime;
    const cover = buffered.find(([s, e]) => s <= cur + 0.05 && e >= cur);
    const kind = classify(v).kind;
    return { hasVideo: true, kind, currentTime: cur, paused: v.paused, duration: v.duration,
      // A plain file can be decoded anywhere the second decoder can seek; report its full span.
      buffered: kind === 'progressive' && Number.isFinite(v.duration) ? [[0, v.duration]] : buffered,
      bufferedUntil: cover ? cover[1] : cur, aheadSeconds: cover ? cover[1] - cur : 0 };
  }

  // Drop captured media chunks entirely behind `before` seconds (init chunks kept).
  function prune(rec, before) {
    for (let i = rec.chunks.length - 1; i >= 0; i--) {
      const c = rec.chunks[i];
      if (!c.init && c.added && c.added[1] < before) {
        rec.chunks.splice(i, 1); rec.bytes -= c.bytes.byteLength; rec.droppedBytes += c.bytes.byteLength;
      }
    }
  }

  // Release buffers of MediaSources no longer attached to any video (navigation, feed scroll),
  // after a grace period for attachment.
  setInterval(() => {
    const attached = new Set(allVideos().map(msOfVideo).filter(id => id != null));
    for (let i = sourceBuffers.length - 1; i >= 0; i--) {
      const rec = sourceBuffers[i];
      if (!attached.has(rec.msId) && performance.now() - rec.createdAt > 30000) {
        rec.chunks.length = 0; rec.bytes = 0; sourceBuffers.splice(i, 1);
      }
    }
    const live = new Set(sourceBuffers.map(r => r.msId));
    for (const [url, id] of mediaUrls) if (!live.has(id) && !attached.has(id) && mediaUrls.size > 16) mediaUrls.delete(url);
  }, 10000);

  // Tell the isolated world which element is being watched (crosses open shadow roots).
  setInterval(() => {
    pickVideo()?.dispatchEvent(new CustomEvent('pawse-main-video', { bubbles: true, composed: true }));
  }, 250);

  function summary() {
    return {
      url: location.href, diag: { ...diag }, player: playerState(),
      sourceBuffers: sourceBuffers.map(r => ({ id: r.id, msId: r.msId, mime: r.mime, appends: r.appends,
        bytesHeld: r.bytes, droppedBytes: r.droppedBytes, initChunks: r.chunks.filter(c => c.init).length,
        coveredByCapture: r.chunks.filter(c => c.added).map(c => c.added).sort((a, b) => a[0] - b[0]).reduce((acc, [s, e]) => {
          const last = acc[acc.length - 1];
          if (last && s <= last[1] + 0.1) last[1] = Math.max(last[1], e); else acc.push([s, e]);
          return acc; }, []),
      })),
    };
  }

  const once = (target, ev, ms = 8000) => new Promise((res, rej) => {
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(ev, done); target.removeEventListener('error', fail); };
    const done = e => { cleanup(); res(e); };
    const fail = () => { cleanup(); rej(new Error('decoder error waiting for ' + ev)); };
    const timer = setTimeout(() => { cleanup(); rej(new Error('timeout waiting for ' + ev)); }, ms);
    target.addEventListener(ev, done, { once: true });
    target.addEventListener('error', fail, { once: true });
  });

  // Append one captured chunk into a decoder SourceBuffer, following codec switches.
  async function replayChunk(sb, c) {
    if (c.mime && sb.__lookaheadMime && c.mime !== sb.__lookaheadMime) {
      Reflect.apply(native.changeType, sb, [c.mime]); sb.__lookaheadMime = c.mime;
    }
    if (!c.init && sb.mode !== c.mode) sb.mode = c.mode;
    if (sb.timestampOffset !== c.tso) sb.timestampOffset = c.tso;
    Reflect.apply(native.appendBuffer, sb, [c.bytes]);
    await once(sb, 'updateend');
  }
  function addDecoderBuffer(ms, mime) {
    const sb = Reflect.apply(native.addSourceBuffer, ms, [mime]);
    sb.__lookaheadMime = mime;
    return sb;
  }

  async function grabFrames(v, decoderBuffered, times, maxWidth, quality) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (const t of times) {
      if (!decoderBuffered.some(([s, e]) => t >= s && t < e)) { frames.push({ requested: t, error: 'not in decoder buffer' }); continue; }
      try {
        if (Math.abs(v.currentTime - t) > 0.001) { v.currentTime = t; await once(v, 'seeked', 10000); }
        if (v.readyState < 2) await once(v, 'loadeddata', 10000);
        const scale = Math.min(1, maxWidth / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;   // throws if cross-origin tainted
        let sum = 0; for (let i = 0; i < px.length; i += 4 * 97) sum += px[i] + px[i + 1] + px[i + 2];
        frames.push({ requested: t, decodedAt: v.currentTime, width: v.videoWidth, height: v.videoHeight,
          meanLuma: sum / (3 * px.length / (4 * 97)), jpeg: canvas.toDataURL('image/jpeg', quality) });
      } catch (e) { frames.push({ requested: t, error: e.name === 'SecurityError' ? 'cross-origin video: pixels not readable' : String(e.message || e) }); }
    }
    return frames;
  }

  /* One-shot: decode frames at absolute media `times` without touching the page's player. */
  async function decodeFuture({ times, maxWidth = 640, quality = 0.8 } = {}) {
    const main = pickVideo();
    const src = classify(main);
    const v = document.createElement('video');
    v.__lookaheadDecoder = true; v.muted = true; v.playsInline = true; v.preload = 'auto';
    if (src.kind === 'progressive') {
      // Plain file: a second element on the same URL. CORS mode so pixels stay readable where the
      // CDN allows it; otherwise grabFrames reports a cross-origin error per frame.
      v.crossOrigin = 'anonymous';
      try {
        native.srcDesc.set.call(v, src.url);
        await once(v, 'loadedmetadata', 10000);
        const frames = await grabFrames(v, [[0, v.duration]], times, maxWidth, quality);
        return { mime: 'progressive', sbId: null, decoderBuffered: [[0, v.duration]], replayedChunks: 0, replayedBytes: 0, errors: [], frames };
      } finally { v.removeAttribute('src'); v.load(); }
    }
    if (src.kind !== 'mse') throw new Error(src.kind === 'drm' ? 'DRM-protected video cannot be decoded'
      : src.kind === 'worker-mse' ? 'This player buffers video in a worker; frames are unavailable'
      : 'no captured video SourceBuffer for this player');
    const rec = src.rec;
    const ms = new MediaSource();
    const decoderUrl = nativeCreateObjectURL(ms);
    try {
      native.srcDesc.set.call(v, decoderUrl);
      await once(ms, 'sourceopen');
      const log = { replayedChunks: 0, replayedBytes: 0, errors: [] };
      // Replay everything since the first init segment, preserving offsets, order and codec switches.
      let start = rec.chunks.findIndex(c => c.init); if (start < 0) start = 0;
      const sb = addDecoderBuffer(ms, rec.chunks[start]?.mime || rec.mime);
      for (let i = start; i < rec.chunks.length; i++) {
        const c = rec.chunks[i];
        try { await replayChunk(sb, c); log.replayedChunks++; log.replayedBytes += c.bytes.byteLength; }
        catch (e) { log.errors.push(`chunk ${c.seq}: ${e.message || e}`); if (log.errors.length > 5) break; }
      }
      const decoderBuffered = ranges(sb.buffered);
      const frames = await grabFrames(v, decoderBuffered, times, maxWidth, quality);
      return { mime: rec.mime, sbId: rec.id, decoderBuffered, ...log, frames };
    } finally {
      Reflect.apply(native.revokeObjectURL, URL, [decoderUrl]); v.removeAttribute('src'); v.load();
    }
  }

  // Raw bytes for offline verification (ffmpeg).
  function exportChunks(sbId, from = 0, to = Infinity) {
    const rec = sourceBuffers.find(r => r.id === sbId);
    if (!rec) return null;
    return rec.chunks.slice(from, to).map(c => {
      let s = ''; const b = c.bytes;
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return { seq: c.seq, tso: c.tso, mime: c.mime, init: c.init, added: c.added, b64: btoa(s) };
    });
  }

  Object.defineProperty(window, '__lookahead', { value: Object.freeze({
    summary, playerState, decodeFuture, exportChunks,
    activeVideoRecord: () => recordForVideo(pickVideo())?.id ?? null,
    // Internals for the standalone live preview overlay (overlay.js). Native calls bypass our hooks.
    _internal: Object.freeze({ pickVideo, classify, recordForVideo, ranges, prune, replayChunk, addDecoderBuffer,
      createObjectURL: nativeCreateObjectURL, setSrc: (v, url) => native.srcDesc.set.call(v, url),
      nativeRemove: native.remove, mainVideo, activeRecord: () => recordForVideo(pickVideo()) }),
  }) });

  // Bridge to the extension's isolated world.
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin || ev.data?.tag !== 'lookahead-req') return;
    const { id, op, args } = ev.data;
    let result, error;
    try {
      if (op === 'decodeFuture' && (!Array.isArray(args?.times) || args.times.length > 5 || !args.times.length || args.times.some(t => !Number.isFinite(t) || t < 0))) throw new Error('Invalid frame request');
      result = op === 'summary' ? summary() : op === 'decodeFuture' ? await decodeFuture({ ...args, maxWidth: 512 }) : undefined;
    }
    catch (e) { error = String(e.message || e); }
    window.postMessage({ tag: 'lookahead-res', id, result, error }, '*');
  });
})();
