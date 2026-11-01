/* Look-ahead capture hook. Runs in every frame's MAIN world at document_start.
 *
 *  - Wraps MediaSource.addSourceBuffer / SourceBuffer.appendBuffer / changeType and keeps a
 *    COPY of every encoded chunk a page hands to MSE, with MIME type, timestampOffset, append
 *    mode and the time range each chunk added. The caller's buffer is passed through untouched.
 *  - Maps each <video> to the MediaSource feeding it (via URL.createObjectURL / srcObject), so
 *    pages with several players work.
 *  - Classifies each video's source: 'mse' (capturable), 'progressive' (plain file URL),
 *    'drm' (EME, cannot decode), 'worker-mse' (MediaSourceHandle, not visible here).
 *  - decodeFuture(): replays captured bytes into a separate hidden MediaSource + <video>.
 *    The page's own player is never touched.
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
    srcObjectDesc: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject'),
  };

  let nextMsId = 1, nextSbId = 1;
  const msIds = new WeakMap();           // MediaSource -> id
  const blobToMs = new Map();            // blob: URL -> MediaSource id
  const sbInfo = new WeakMap();          // SourceBuffer -> record
  const sourceBuffers = [];              // records, in creation order
  const handleVideos = new WeakSet();    // videos fed by a worker MediaSourceHandle
  const diag = { workersCreated: 0, mediaSourceHandleAttached: false, hookErrors: [],
    workerMseSupported: !!MediaSource.canConstructInDedicatedWorker };
  const msId = (ms) => { if (!msIds.has(ms)) msIds.set(ms, nextMsId++); return msIds.get(ms); };

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
      if (obj instanceof MediaSource) blobToMs.set(url, msId(obj));
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
            const chunk = { seq: rec.nextSeq++, at: performance.now(), tso: this.timestampOffset,
              mode: this.mode, init: looksLikeInit(copy), bytes: copy, added: null };
            rec.chunks.push(chunk); rec.bytes += copy.byteLength; rec.appends++;
            const sb = this;
            sb.addEventListener('updateend', () => { chunk.added = addedRange(before, ranges(sb.buffered)); }, { once: true });
            while (rec.bytes > MAX_BYTES_PER_SB) {           // memory cap: drop oldest media chunks
              const idx = rec.chunks.findIndex(c => !c.init && !c.changeType);
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

  if (native.changeType) wrap('changeType', () => {
    SourceBuffer.prototype.changeType = function (mime) {
      const rec = sbInfo.get(this);
      if (rec) rec.chunks.push({ seq: rec.nextSeq++, changeType: String(mime), bytes: new Uint8Array(0), init: null });
      return Reflect.apply(native.changeType, this, [mime]);
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
        if (v && this instanceof HTMLVideoElement && !this.__lookaheadDecoder) knownVideos.add(this);
        return native.srcObjectDesc.set.call(this, v);
      },
    });
  });

  // Videos inside shadow DOM (e.g. Reddit's <shreddit-player>) are invisible to querySelectorAll,
  // so also register any <video> whose src/srcObject the page sets.
  const knownVideos = new Set();
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (srcDesc?.set) wrap('src', () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...srcDesc,
      set(v) { if (this instanceof HTMLVideoElement && !this.__lookaheadDecoder) knownVideos.add(this); return srcDesc.set.call(this, v); },
    });
  });

  // ---------- video <-> source mapping ----------
  const allVideos = () => {
    const set = new Set(document.querySelectorAll('video'));
    for (const v of knownVideos) { if (v.isConnected) set.add(v); else knownVideos.delete(v); }
    return [...set].filter(v => !v.__lookaheadDecoder);
  };

  function msOfVideo(v) {
    const so = native.srcObjectDesc?.get?.call(v);
    if (so instanceof MediaSource) return msId(so);
    const src = v.currentSrc || v.src;
    return src && src.startsWith('blob:') ? (blobToMs.get(src) ?? null) : null;
  }
  function recordForVideo(v) {
    if (!v) return null;
    const id = msOfVideo(v);
    if (id == null) return null;
    return sourceBuffers.filter(r => r.msId === id && r.mime.startsWith('video/') && r.appends > 0).pop() || null;
  }
  // Real encryption markers in an init segment: MP4 'encv'/'enca'/'tenc' boxes, WebM ContentEncodings (0x6D80) + ContentEncKeyID (0x47E2).
  const ascii = (u8, s) => { outer: for (let i = 0; i + s.length <= u8.length; i++) { for (let j = 0; j < s.length; j++) if (u8[i + j] !== s.charCodeAt(j)) continue outer; return true; } return false; };
  const isEncrypted = (rec) => rec.chunks.some(c => c.init && (c.init === 'mp4'
    ? (ascii(c.bytes, 'encv') || ascii(c.bytes, 'enca') || ascii(c.bytes, 'tenc'))
    : (c.bytes.some((b, i) => b === 0x6d && c.bytes[i + 1] === 0x80) && c.bytes.some((b, i) => b === 0x47 && c.bytes[i + 1] === 0xe2))));
  function classify(v) {
    if (!v) return { kind: 'none' };
    if (handleVideos.has(v)) return { kind: 'worker-mse' };
    const rec = recordForVideo(v);
    // Some players (e.g. Vimeo) attach MediaKeys even to clear streams, so check the bytes.
    if (rec) return rec.encrypted ?? (rec.encrypted = isEncrypted(rec)) ? { kind: 'drm' } : { kind: 'mse', rec };
    if (v.mediaKeys) return { kind: 'drm' };
    const src = v.currentSrc || v.src || '';
    if (/^(https?|file|data):/.test(src)) return { kind: 'progressive', url: src };
    if (src.startsWith('blob:')) return { kind: blobToMs.has(src) ? 'mse-pending' : 'blob-unknown' };
    if (native.srcObjectDesc?.get?.call(v)) return { kind: 'stream' }; // e.g. webcam MediaStream
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

  function playerState(v = pickVideo()) {
    if (!v) return { hasVideo: false };
    const buffered = ranges(v.buffered);
    const cur = v.currentTime;
    const cover = buffered.find(([s, e]) => s <= cur + 0.05 && e >= cur);
    return { hasVideo: true, kind: classify(v).kind, currentTime: cur, paused: v.paused, duration: v.duration,
      buffered, bufferedUntil: cover ? cover[1] : cur, aheadSeconds: cover ? cover[1] - cur : 0 };
  }

  // Drop captured media chunks entirely behind `before` seconds (init/changeType markers kept).
  function prune(rec, before) {
    for (let i = rec.chunks.length - 1; i >= 0; i--) {
      const c = rec.chunks[i];
      if (!c.init && !c.changeType && c.added && c.added[1] < before) {
        rec.chunks.splice(i, 1); rec.bytes -= c.bytes.byteLength; rec.droppedBytes += c.bytes.byteLength;
      }
    }
  }

  function summary() {
    return {
      url: location.href, diag: { ...diag }, player: playerState(),
      sourceBuffers: sourceBuffers.map(r => ({ id: r.id, msId: r.msId, mime: r.mime, appends: r.appends,
        bytesHeld: r.bytes, droppedBytes: r.droppedBytes, initChunks: r.chunks.filter(c => c.init).length,
        changeTypes: r.chunks.filter(c => c.changeType).map(c => c.changeType),
        coveredByCapture: r.chunks.filter(c => c.added).map(c => c.added).sort((a, b) => a[0] - b[0]).reduce((acc, [s, e]) => {
          const last = acc[acc.length - 1];
          if (last && s <= last[1] + 0.1) last[1] = Math.max(last[1], e); else acc.push([s, e]);
          return acc; }, []),
      })),
    };
  }

  const once = (target, ev, ms = 8000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
    target.addEventListener(ev, (e) => { clearTimeout(t); res(e); }, { once: true });
  });

  // Append one captured chunk (or replay a changeType marker) into a decoder SourceBuffer.
  async function replayChunk(sb, c) {
    if (c.changeType) { Reflect.apply(native.changeType, sb, [c.changeType]); return; }
    if (!c.init && sb.mode !== c.mode) sb.mode = c.mode;
    if (sb.timestampOffset !== c.tso) sb.timestampOffset = c.tso;
    Reflect.apply(native.appendBuffer, sb, [c.bytes]);
    await once(sb, 'updateend');
  }

  /* One-shot: replay captured bytes into an isolated decoder and grab frames at `times`. */
  async function decodeFuture({ times, maxWidth = 640, quality = 0.8, video } = {}) {
    const rec = recordForVideo(video || pickVideo()) || sourceBuffers.filter(r => r.mime.startsWith('video/') && r.appends > 0).pop();
    if (!rec) throw new Error('no captured video SourceBuffer for this player');
    const v = document.createElement('video');
    v.__lookaheadDecoder = true; v.muted = true; v.preload = 'auto';
    const ms = new MediaSource();
    v.src = Reflect.apply(native.createObjectURL, URL, [ms]);
    await once(ms, 'sourceopen');
    const sb = Reflect.apply(native.addSourceBuffer, ms, [rec.mime]);
    const log = { replayedChunks: 0, replayedBytes: 0, errors: [] };
    let start = rec.chunks.findIndex(c => c.init); if (start < 0) start = 0;
    for (let i = start; i < rec.chunks.length; i++) {
      try { await replayChunk(sb, rec.chunks[i]); log.replayedChunks++; log.replayedBytes += rec.chunks[i].bytes.byteLength; }
      catch (e) { log.errors.push(`chunk ${rec.chunks[i].seq}: ${e.message || e}`); if (log.errors.length > 5) break; }
    }
    const decoderBuffered = ranges(sb.buffered);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (const t of times) {
      if (!decoderBuffered.some(([s, e]) => t >= s && t < e)) { frames.push({ requested: t, error: 'not in decoder buffer' }); continue; }
      try {
        if (Math.abs(v.currentTime - t) > 0.001) { v.currentTime = t; await once(v, 'seeked'); }
        if (v.readyState < 2) await once(v, 'loadeddata');
        const scale = Math.min(1, maxWidth / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0; for (let i = 0; i < px.length; i += 4 * 97) sum += px[i] + px[i + 1] + px[i + 2];
        frames.push({ requested: t, decodedAt: v.currentTime, width: v.videoWidth, height: v.videoHeight,
          meanLuma: sum / (3 * px.length / (4 * 97)), jpeg: canvas.toDataURL('image/jpeg', quality) });
      } catch (e) { frames.push({ requested: t, error: String(e.message || e) }); }
    }
    URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load();
    return { mime: rec.mime, sbId: rec.id, decoderBuffered, ...log, frames };
  }

  // Raw bytes for offline verification (ffmpeg).
  function exportChunks(sbId, from = 0, to = Infinity) {
    const rec = sourceBuffers.find(r => r.id === sbId);
    if (!rec) return null;
    return rec.chunks.filter(c => !c.changeType).slice(from, to).map(c => {
      let s = ''; const b = c.bytes;
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return { seq: c.seq, tso: c.tso, init: c.init, added: c.added, b64: btoa(s) };
    });
  }

  Object.defineProperty(window, '__lookahead', { value: Object.freeze({
    summary, playerState, decodeFuture, exportChunks,
    activeVideoRecord: () => recordForVideo(pickVideo())?.id ?? null,
    _internal: Object.freeze({ pickVideo, classify, recordForVideo, ranges, prune, replayChunk,
      createObjectURL: (o) => Reflect.apply(native.createObjectURL, URL, [o]),
      nativeAddSourceBuffer: native.addSourceBuffer, nativeRemove: native.remove,
      mainVideo: pickVideo, activeRecord: () => recordForVideo(pickVideo()) }),
  }) });
})();
