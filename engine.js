/* Isolated-world coordinator: buffered frames -> service worker -> Decisions -> guard.
 * No API credentials or raw image previews are exposed in the child UI. */
(() => {
  let sequence = 0;
  const pending = new Map();
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.tag !== "lookahead-res") return;
    const request = pending.get(event.data.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(event.data.id);
    event.data.error ? request.reject(new Error(event.data.error)) : request.resolve(event.data.result);
  });
  function capture(op, args) {
    return new Promise((resolve, reject) => {
      const id = `sprout-${++sequence}-${crypto.randomUUID()}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Frame capture timed out. Reload the YouTube tab.")); }, 15000);
      pending.set(id, {resolve, reject, timer});
      window.postMessage({tag: "lookahead-req", id, op, args}, location.origin);
    });
  }
  const mainVideo = () => document.querySelector("#movie_player video") || document.querySelector("video");
  class Engine {
    constructor(render) {
      this.render = render; this.generation = 0; this.windows = new Map(); this.mode = "off";
      this.timer = setInterval(() => this.tick(), 100);
      document.addEventListener("seeking", () => this.guard(), true);
      document.addEventListener("play", () => this.guard(), true);
    }
    reset(videoId, mode = "connecting", preview = false) {
      this.generation++; this.videoId = videoId; this.windows.clear(); this.mode = mode;
      this.preview = preview; this.lastKey = ""; this.error = ""; this.retryAt = 0;
      this.source = null; this.lastReport = 0;
      this.guard();
    }
    emit(decision) {
      decision = {...decision, videoId: this.videoId, preview: this.preview};
      const key = JSON.stringify(decision);
      if (key !== this.lastKey) { this.lastKey = key; this.render(decision); }
      if (Date.now() - this.lastReport > 1500 || key !== this.reportKey) {
        this.lastReport = Date.now(); this.reportKey = key;
        chrome.runtime.sendMessage({type: "report_decision", decision}).catch(() => {});
      }
    }
    guard() {
      const video = mainVideo();
      if (!video || !this.videoId) return;
      let decision;
      if (this.mode !== "live") decision = {status: this.mode};
      else if (document.querySelector("#movie_player.ad-showing")) decision = {status: "connecting", detail: "Ads need a grown-up’s review."};
      else {
        if (this.source !== video.currentSrc) {
          this.source = video.currentSrc; this.generation++; this.windows.clear();
        }
        decision = SproutGuard.evaluate(this.windows, video.currentTime, video.duration);
        if (decision.status === "connecting" && this.error) decision.detail = this.error;
      }
      const hold = ["connecting", "review", "blocked"].includes(decision.status);
      video.style.filter = hold ? "blur(24px)" : "";
      if (hold) {
        if (!video.paused) this.resumeAfterCheck = true;
        video.pause();
      }
      this.emit(decision);
      if (!hold && this.resumeAfterCheck) {
        this.resumeAfterCheck = false;
        video.play().catch(() => {});
      }
    }
    tick() {
      this.guard();
      if (this.mode !== "live" || this.busy || Date.now() < this.retryAt) return;
      const generation = this.generation;
      this.scan().catch(error => {
        if (generation !== this.generation) return;
        this.error = error.message; this.retryAt = Date.now() + 3000;
      });
    }
    async scan() {
      const video = mainVideo();
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0 || document.querySelector("#movie_player.ad-showing")) return;
      const generation = this.generation;
      const videoId = this.videoId;
      const index = Math.floor(video.currentTime / SproutGuard.WINDOW);
      let target = index;
      while (this.windows.has(target) && target <= index + 3) target++;
      if (target > index + 3) return;
      const start = target * SproutGuard.WINDOW, end = Math.min(video.duration, start + SproutGuard.WINDOW);
      if (start >= end) return;
      this.busy = true;
      try {
        const summary = await capture("summary");
        if (summary.diag.mediaSourceHandleAttached) throw new Error("This player’s video buffer is unavailable. Ask a grown-up.");
        const times = [];
        for (let t = start; t < end; t += 1) times.push(Math.min(t + .1, (t + end) / 2));
        if (!times.every(t => summary.player.buffered?.some(([s, e]) => t >= s && t < e - .02))) {
          this.error = "Waiting for YouTube to buffer the next few seconds…";
          this.retryAt = Date.now() + 600; return;
        }
        const decoded = await capture("decodeFuture", {times, maxWidth: 512, quality: .75});
        if (generation !== this.generation) return;
        if (decoded.frames?.length !== times.length || decoded.frames.some((f, i) => !f.jpeg || f.error || Math.abs(f.decodedAt - times[i]) > .15)) {
          throw new Error("Couldn’t capture every frame. Playback is held while Pawse retries.");
        }
        const result = await chrome.runtime.sendMessage({type: "classify_frames", scan: {
          videoId, start, end, frames: decoded.frames.map(f => ({timestamp: f.decodedAt, jpeg: f.jpeg}))
        }});
        if (generation !== this.generation) return;
        if (!["safe", "review", "blocked"].includes(result?.status) || result.videoId !== videoId || result.start !== start || result.end !== end || result.provenance !== "live") {
          throw new Error(result?.error || "Incomplete Decisions result. Please check the local backend.");
        }
        const category = result.category?.replaceAll("_", " ");
        result.detail = result.status === "safe"
          ? `Visual samples checked to ${end.toFixed(1)}s · ${result.frameCount} frames · ${result.apiSeconds}s`
          : `Upcoming ${category || "content"} needs a grown-up’s review (${Math.round(result.probability * 100)}%).`;
        this.windows.set(target, result); this.error = "";
        // Bound session memory on long videos; seeking back safely triggers fresh checks.
        for (const key of this.windows.keys()) if (key < index - 20) this.windows.delete(key);
        this.guard();
      } finally { this.busy = false; }
    }
  }
  globalThis.SproutEngine = Engine;
})();
