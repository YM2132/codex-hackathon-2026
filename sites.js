// Supported-site adapters, shared by content scripts, the service worker, the popup and Node tests.
// Pure at load time (no DOM access), so the service worker can importScripts() it.
//
// A "video key" identifies what is being checked:
//   - YouTube / YouTube Kids: the bare 11-character video ID (unchanged contract).
//   - Other sites: "<site>:<id>" from the URL, e.g. "tiktok:7675478347278863629".
//   - Feeds with no per-video URL (TikTok For You, Instagram/X/Reddit timelines):
//     "<site>:page-<hash>" for the page; the engine re-checks whenever the playing source changes.
(() => {
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  const KEY = /^(?:[A-Za-z0-9_-]{11}|[a-z]{1,16}:[A-Za-z0-9_.-]{1,80})$/;
  const match = (re) => (url) => (url.pathname.match(re) || [])[1] || "";
  const youtubeId = (url) => {
    const id = url.searchParams.get("v") || "";
    return url.pathname === "/watch" && YT_ID.test(id) ? id : "";
  };
  const ytPlayer = () => document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
  const ytAd = () => !!document.querySelector(".html5-video-player.ad-showing");

  const SITES = [
    {id: "youtube", name: "YouTube", hosts: ["www.youtube.com"], home: "https://www.youtube.com/",
      videoId: youtubeId, feeds: false, player: ytPlayer, ad: ytAd},
    {id: "youtubekids", name: "YouTube Kids", hosts: ["www.youtubekids.com"], home: "https://www.youtubekids.com/",
      videoId: youtubeId, feeds: false, player: ytPlayer, ad: ytAd},
    {id: "tiktok", name: "TikTok", hosts: ["www.tiktok.com"], home: "https://www.tiktok.com/",
      videoId: match(/\/video\/(\d{5,25})/), feeds: true},
    {id: "instagram", name: "Instagram", hosts: ["www.instagram.com"], home: "https://www.instagram.com/",
      videoId: match(/\/(?:reels?|p)\/([A-Za-z0-9_-]{5,40})/), feeds: true},
    {id: "x", name: "X", hosts: ["x.com"], home: "https://x.com/",
      videoId: match(/\/status\/(\d{5,25})/), feeds: true},
    {id: "reddit", name: "Reddit", hosts: ["www.reddit.com"], home: "https://www.reddit.com/",
      videoId: match(/\/comments\/([a-z0-9]{3,12})/), feeds: true},
    {id: "snapchat", name: "Snapchat", hosts: ["www.snapchat.com"], home: "https://www.snapchat.com/",
      videoId: match(/\/spotlight\/([A-Za-z0-9_-]{5,80})/), feeds: true},
    // The Dailymotion video plays inside a geo.dailymotion.com iframe; the top page only hosts it.
    {id: "dailymotion", name: "Dailymotion", hosts: ["www.dailymotion.com"], home: "https://www.dailymotion.com/",
      videoId: match(/\/video\/(x[a-z0-9]{3,12})/), feeds: true, playerInChildFrame: true, margin: .6},
    {id: "dailymotion", name: "Dailymotion", hosts: ["geo.dailymotion.com"], home: "https://www.dailymotion.com/",
      videoId: (url) => /^x[a-z0-9]{3,12}$/.test(url.searchParams.get("video") || "") ? url.searchParams.get("video") : "",
      // Only ~3 s is buffered ahead here, so a 3 s stop margin would hold playback permanently.
      feeds: true, embedded: true, margin: .6},
  ];

  const parse = (value) => { try { return new URL(value); } catch { return null; } };
  function siteFor(value) {
    const url = parse(value);
    return url && url.protocol === "https:" ? SITES.find((s) => s.hosts.includes(url.hostname)) || null : null;
  }
  // Short stable hash for page keys (FNV-1a, base36).
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function videoKey(value) {
    const site = siteFor(value);
    if (!site) return "";
    const url = parse(value);
    const id = site.videoId(url);
    if (id) return site.id === "youtube" || site.id === "youtubekids" ? id : `${site.id}:${id}`;
    return site.feeds ? `${site.id}:page-${hash(url.hostname + url.pathname)}` : "";
  }
  const isPageKey = (key) => /^[a-z]+:page-/.test(key || "");
  const isValidKey = (key) => KEY.test(key || "");

  globalThis.SproutSites = {SITES, KEY, siteFor, videoKey, isPageKey, isValidKey, hash};
  if (typeof module !== "undefined") module.exports = globalThis.SproutSites;
})();
