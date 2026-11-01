// Pure timeline policy, shared by the content controller and Node tests.
(() => {
  const WINDOW = 3;        // seconds per checked window (must match backend validation)
  const MARGIN = 10;       // stop this many seconds before an unchecked or flagged window
  const SCAN_AHEAD = Infinity; // check every window the site has already buffered (nearest first)
  function videoIdFromUrl(value) {
    try {
      const url = new URL(value);
      const id = url.searchParams.get("v") || "";
      return url.hostname === "www.youtube.com" && url.pathname === "/watch" && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
    } catch { return ""; }
  }
  function evaluate(windows, time, duration, margin = MARGIN) {
    const index = Math.floor(time / WINDOW);
    const current = windows.get(index);
    if (!current) return {status: "connecting", detail: "Checking the next few seconds…"};
    if (current.status !== "safe") return current;
    // Every window starting within `margin` seconds must already be safe (also covers >1x speed).
    const horizon = Math.min(time + margin, duration - .05);
    for (let i = index + 1; i * WINDOW < horizon; i++) {
      const next = windows.get(i);
      if (!next) return {status: "connecting", detail: "Checking the next few seconds…"};
      if (next.status !== "safe") return next;
    }
    return current;
  }
  globalThis.SproutGuard = {WINDOW, MARGIN, SCAN_AHEAD, videoIdFromUrl, evaluate};
  if (typeof module !== "undefined") module.exports = globalThis.SproutGuard;
})();
