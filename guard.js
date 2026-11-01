// Pure timeline policy, shared by the content controller and Node tests.
(() => {
  const WINDOW = 3;
  function videoIdFromUrl(value) {
    try {
      const url = new URL(value);
      const id = url.searchParams.get("v") || "";
      return url.hostname === "www.youtube.com" && url.pathname === "/watch" && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
    } catch { return ""; }
  }
  function evaluate(windows, time, duration) {
    const index = Math.floor(time / WINDOW);
    const current = windows.get(index);
    if (!current) return {status: "connecting", detail: "Checking the next few seconds…"};
    if (current.status !== "safe") return current;
    // Stop before crossing into an unknown or flagged window, including at >1x speed.
    if (current.end - time <= .6 && current.end < duration - .05) {
      const next = windows.get(index + 1);
      if (!next) return {status: "connecting", detail: "Checking the next few seconds…"};
      if (next.status !== "safe") return next;
    }
    return current;
  }
  globalThis.SproutGuard = {WINDOW, videoIdFromUrl, evaluate};
  if (typeof module !== "undefined") module.exports = globalThis.SproutGuard;
})();
