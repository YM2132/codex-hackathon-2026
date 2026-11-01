/* Look-ahead capture hook. Runs in the page's MAIN world at document_start.
 *
 * What it does:
 *  - Wraps MediaSource.prototype.addSourceBuffer / SourceBuffer.prototype.appendBuffer
 *    and keeps a COPY of every encoded chunk the page hands to the browser, together
 *    with the SourceBuffer's MIME type, timestampOffset, and the time range the chunk
 *    added to that SourceBuffer's buffered ranges.
 *  - The original ArrayBuffer is never modified or detached: we copy with slice()
 *    and pass the caller's exact object through to the native appendBuffer.
 *  - Detects playback paths we cannot see from here (MSE in a dedicated worker,
 *    attached via MediaSourceHandle) and reports them instead of failing silently.
 *  - decodeFuture(): replays the captured byte sequence into a brand-new hidden
 *    MediaSource + <video>, seeks THAT element, and draws frames to a canvas.
 *    The page's own player is never touched.
 */
(() => {
  if (window.__lookahead) return;

  const MAX_BYTES_PER_SB = 96 * 1024 * 1024;
  const native = {
    addSourceBuffer: MediaSource.prototype.addSourceBuffer,
    appendBuffer: SourceBuffer.prototype.appendBuffer,
    remove: SourceBuffer.prototype.remove,
    changeType: SourceBuffer.prototype.changeType,
    srcObjectSet: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject')?.set,
  };

  let nextMsId = 1, nextSbId = 1;
  const msIds = new WeakMap();
  const mediaUrls = new Map();
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    const url = Reflect.apply(createObjectURL, URL, [object]);
    if (object instanceof MediaSource) mediaUrls.set(url, object);
    return url;
  };
  const revokeObjectURL = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) {
    // YouTube may revoke a blob URL immediately after attaching it. Keep its
    // identity until navigation so the current player's record remains resolvable.
    return Reflect.apply(revokeObjectURL, URL, [url]);
  };
  const sbInfo = new WeakMap();          // SourceBuffer -> record
  const sourceBuffers = [];              // records, in creation order
  // Retain only the current player's buffers after a grace period for attachment.
  setInterval(() => {
    const v = mainVideo();
    const url = v?.currentSrc || v?.src;
    const active = mediaUrls.get(url);
    const activeId = active && msIds.get(active);
    for (let i = sourceBuffers.length - 1; i >= 0; i--) {
      const rec = sourceBuffers[i];
      if (rec.msId !== activeId && performance.now() - rec.createdAt > 30000) {
        rec.chunks.length = 0; rec.bytes = 0; sourceBuffers.splice(i, 1);
      }
    }
    if (mediaUrls.size > 16) for (const key of mediaUrls.keys()) {
      if (key !== url) mediaUrls.delete(key);
      if (mediaUrls.size <= 16) break;
    }
  }, 10000);
  const diag = { workersCreated: 0, mediaSourceHandleAttached: false, hookErrors: [],
    workerMseSupported: !!MediaSource.canConstructInDedicatedWorker };

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
      let covered = before.some(([bs, be]) => bs <= s + 0.01 && be >= e - 0.01);
      if (!covered) {
        // find the part not previously covered
        let ns = s, ne = e;
        for (const [bs, be] of before) {
          if (bs <= ns + 0.01 && be > ns) ns = be;
          if (be >= ne - 0.01 && bs < ne) ne = bs;
        }
        if (ne > ns) { lo = Math.min(lo, ns); hi = Math.max(hi, ne); }
      }
    }
    return Number.isFinite(lo) ? [lo, hi] : null;
  };

  try {
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = Reflect.apply(native.addSourceBuffer, this, [mime]);
      if (!msIds.has(this)) msIds.set(this, nextMsId++);
      const rec = { id: nextSbId++, msId: msIds.get(this), mime: String(mime), createdAt: performance.now(),
        chunks: [], bytes: 0, droppedBytes: 0, appends: 0 };
      sbInfo.set(sb, rec);
      sourceBuffers.push(rec);
      return sb;
    };
  } catch (e) { diag.hookErrors.push('addSourceBuffer: ' + e); }

  try {
    SourceBuffer.prototype.appendBuffer = function (data) {
      const rec = sbInfo.get(this);
      if (rec) {
        try {
          const copy = toU8Copy(data);
          if (copy) {
            const before = ranges(this.buffered);
            const chunk = { seq: rec.appends, at: performance.now(), tso: this.timestampOffset, mime: rec.mime,
              mode: this.mode, init: looksLikeInit(copy), bytes: copy, added: null };
            rec.chunks.push(chunk); rec.bytes += copy.byteLength; rec.appends++;
            const sb = this;
            sb.addEventListener('updateend', () => { chunk.added = addedRange(before, ranges(sb.buffered)); }, { once: true });
            // Memory cap: drop oldest non-init chunks.
            while (rec.bytes > MAX_BYTES_PER_SB) {
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
  } catch (e) { diag.hookErrors.push('appendBuffer: ' + e); }

  // YouTube can create a VP9 buffer, then switch it to AV1 before appending.
  // Replaying those MP4 bytes as the original WebM MIME fails at the first chunk.
  if (native.changeType) {
    SourceBuffer.prototype.changeType = function (mime) {
      const result = Reflect.apply(native.changeType, this, [mime]);
      const rec = sbInfo.get(this);
      if (rec) rec.mime = String(mime);
      return result;
    };
  }

  // Diagnostics for paths this hook cannot observe.
  try {
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, { construct(t, a, nt) { diag.workersCreated++; return Reflect.construct(t, a, nt); } });
  } catch (e) { diag.hookErrors.push('Worker: ' + e); }
  if (native.srcObjectSet && window.MediaSourceHandle) {
    try {
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        ...Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject'),
        set(v) { if (v instanceof MediaSourceHandle) diag.mediaSourceHandleAttached = true; return native.srcObjectSet.call(this, v); },
      });
    } catch (e) { diag.hookErrors.push('srcObject: ' + e); }
  }

  const mainVideo = () => {
    const vids = [...document.querySelectorAll('video')].filter(v => !v.__lookaheadDecoder);
    return vids.find(v => v.src && v.src.startsWith('blob:')) || vids[0] || null;
  };

  function playerState() {
    const v = mainVideo();
    if (!v) return { hasVideo: false };
    const buffered = ranges(v.buffered);
    const cur = v.currentTime;
    const cover = buffered.find(([s, e]) => s <= cur + 0.05 && e >= cur);
    return { hasVideo: true, currentTime: cur, paused: v.paused, duration: v.duration,
      buffered, bufferedUntil: cover ? cover[1] : cur, aheadSeconds: cover ? cover[1] - cur : 0,
      src: v.src ? v.src.slice(0, 5) : null, srcObject: v.srcObject ? v.srcObject.constructor.name : null };
  }

  function summary() {
    return {
      diag: { ...diag },
      player: playerState(),
      sourceBuffers: sourceBuffers.map(r => ({ id: r.id, msId: r.msId, mime: r.mime, appends: r.appends,
        bytesHeld: r.bytes, droppedBytes: r.droppedBytes, initChunks: r.chunks.filter(c => c.init).length,
        coveredByCapture: r.chunks.filter(c => c.added).map(c => c.added).reduce((acc, [s, e]) => {
          const last = acc[acc.length - 1];
          if (last && s <= last[1] + 0.1) last[1] = Math.max(last[1], e); else acc.push([s, e]);
          return acc; }, []),
      })),
    };
  }

  // Latest video SourceBuffer that belongs to the MediaSource currently attached.
  function activeVideoRecord() {
    const vids = sourceBuffers.filter(r => r.mime.startsWith('video/') && r.appends > 0);
    if (!vids.length) return null;
    const video = mainVideo();
    const ms = mediaUrls.get(video?.currentSrc || video?.src);
    const attachedId = ms && msIds.get(ms);
    return vids.filter(r => r.msId === attachedId).pop() || null;
  }

  const once = (target, ev, ms = 8000) => new Promise((res, rej) => {
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(ev, done); target.removeEventListener('error', fail); };
    const done = e => { cleanup(); res(e); };
    const fail = () => { cleanup(); rej(new Error('decoder error waiting for ' + ev)); };
    const timer = setTimeout(() => { cleanup(); rej(new Error('timeout waiting for ' + ev)); }, ms);
    target.addEventListener(ev, done, {once: true});
    target.addEventListener('error', fail, {once: true});
  });

  /* Replay captured encoded bytes into an isolated decoder and grab frames.
   * times: absolute media timestamps (seconds). */
  async function decodeFuture({ times, maxWidth = 640, quality = 0.8 } = {}) {
    const rec = activeVideoRecord();
    if (!rec) throw new Error('no captured video SourceBuffer (worker MSE or not yet started?)');
    const v = document.createElement('video');
    v.__lookaheadDecoder = true; v.muted = true; v.playsInline = true; v.preload = 'auto';
    const ms = new MediaSource();
    const decoderUrl = Reflect.apply(createObjectURL, URL, [ms]);
    try {
      v.src = decoderUrl;
      await once(ms, 'sourceopen');
      let sb;
      const log = { replayedChunks: 0, replayedBytes: 0, errors: [] };
      {
        let decoderMime = rec.chunks[0]?.mime || rec.mime;
        sb = Reflect.apply(native.addSourceBuffer, ms, [decoderMime]);
        // Replay from the most recent init segment onward, preserving offsets & order.
        let start = 0;
        for (let i = rec.chunks.length - 1; i >= 0; i--) if (rec.chunks[i].init) { start = i; break; }
        // Earlier init chunks may still be needed if quality switched; replay everything since the first init.
        start = rec.chunks.findIndex(c => c.init); if (start < 0) start = 0;
        for (let i = start; i < rec.chunks.length; i++) {
          const c = rec.chunks[i];
          try {
            if (c.mime && c.mime !== decoderMime) {
              Reflect.apply(native.changeType, sb, [c.mime]);
              decoderMime = c.mime;
            }
            if (sb.mode !== c.mode && !c.init) sb.mode = c.mode;
            if (sb.timestampOffset !== c.tso) sb.timestampOffset = c.tso;
            Reflect.apply(native.appendBuffer, sb, [c.bytes]);
            await once(sb, 'updateend');
            log.replayedChunks++; log.replayedBytes += c.bytes.byteLength;
          } catch (e) { log.errors.push(`chunk ${c.seq}: ${e.message || e}`); if (log.errors.length > 5) break; }
        }
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
      return { mime: rec.mime, sbId: rec.id, decoderBuffered, ...log, frames };
    } finally {
      URL.revokeObjectURL(decoderUrl); v.removeAttribute('src'); v.load();
    }
  }

  // Raw bytes for offline verification (ffmpeg). Returns base64 of init + chunks [from, to).
  function exportChunks(sbId, from = 0, to = Infinity) {
    const rec = sourceBuffers.find(r => r.id === sbId);
    if (!rec) return null;
    return rec.chunks.slice(from, to).map(c => {
      let s = ''; const b = c.bytes;
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return { seq: c.seq, tso: c.tso, init: c.init, added: c.added, b64: btoa(s) };
    });
  }

  Object.defineProperty(window, '__lookahead', { value: Object.freeze({
    summary, playerState, decodeFuture, exportChunks, activeVideoRecord: () => activeVideoRecord()?.id ?? null,
    // Internals for the live preview overlay (overlay.js). Native functions bypass our hooks.
    _internal: Object.freeze({ activeRecord: activeVideoRecord, mainVideo, ranges,
      nativeAddSourceBuffer: native.addSourceBuffer, nativeAppend: native.appendBuffer, nativeRemove: native.remove }),
  }) });

  // Bridge to the extension's isolated world.
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin || ev.data?.tag !== 'lookahead-req') return;
    const { id, op, args } = ev.data;
    let result, error;
    try {
      if (op === 'decodeFuture' && (!Array.isArray(args?.times) || args.times.length > 5 || !args.times.length || args.times.some(t => !Number.isFinite(t) || t < 0))) throw new Error('Invalid frame request');
      result = op === 'summary' ? summary() : op === 'decodeFuture' ? await decodeFuture({...args, maxWidth: 512}) : undefined;
    }
    catch (e) { error = String(e.message || e); }
    window.postMessage({ tag: 'lookahead-res', id, result, error }, '*');
  });
})();
