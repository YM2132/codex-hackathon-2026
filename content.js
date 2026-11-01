(() => {
  if (window.__sproutProtectionLoaded) return;
  window.__sproutProtectionLoaded = true;

  let currentVideoId = "";
  let root;
  let shadow;
  let lastStatus = "";
  let refreshTimer;
  const pauseStatuses = new Set(["connecting", "review", "blocked"]);

  function videoIdFromUrl() {
    const url = new URL(location.href);
    if (url.pathname === "/watch") return url.searchParams.get("v") || "";
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    return "";
  }

  function player() {
    return document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
  }

  function ensureOverlay() {
    const host = player();
    if (!host) return false;
    if (root?.isConnected && root.parentElement === host) return true;
    root?.remove();
    root = document.createElement("div");
    root.id = "sprout-protection-root";
    root.setAttribute("aria-live", "polite");
    shadow = root.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .scrim { position:absolute; inset:0; z-index:999999; display:grid; place-items:center; padding:20px; box-sizing:border-box; background:rgba(14,25,38,.78); color:#172b35; font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        .card { width:min(440px,100%); box-sizing:border-box; padding:24px; border-radius:22px; background:#fffdf8; box-shadow:0 18px 64px rgba(0,0,0,.28); }
        .mascot { display:block; width:84px; height:84px; margin:0 auto 12px; border-radius:22px; object-fit:cover; animation:sprout-float 3.2s ease-in-out infinite; }
        @keyframes sprout-float { 0%,100% { transform:translateY(2px); } 50% { transform:translateY(-3px); } }
        @media (prefers-reduced-motion: reduce) { .mascot { animation:none; } }
        .brand { display:flex; align-items:center; gap:9px; margin-bottom:18px; color:#176554; font-size:12px; font-weight:750; letter-spacing:.04em; text-transform:uppercase; }
        .mark { width:25px; height:25px; display:grid; place-items:center; border-radius:9px; background:#d9f3e9; font-size:15px; }
        h2 { margin:0 0 8px; color:#17333b; font-size:23px; line-height:1.18; letter-spacing:-.03em; }
        p { margin:0; color:#5d6c70; font-size:14px; }
        .preview { display:inline-flex; margin-top:15px; padding:5px 9px; border-radius:99px; background:#fff3d8; color:#725112; font-size:11px; font-weight:700; }
        .kid-note { display:flex; align-items:center; gap:9px; margin-top:16px; padding:11px 12px; border-radius:13px; background:#f0f6ef; color:#35554b; font-size:12px; font-weight:650; }
        .kid-note span { display:grid; width:24px; height:24px; flex:0 0 24px; place-items:center; border-radius:50%; background:#d9f3e9; color:#176554; font-size:15px; }
        .offline-note { background:#fff4df; color:#6b511f; }
        .offline-note span { background:#ffe7b7; color:#80580d; }
        .actions { display:flex; flex-direction:column; gap:9px; margin-top:22px; }
        button { min-height:44px; border:0; border-radius:13px; padding:0 14px; font:700 14px system-ui,sans-serif; cursor:pointer; }
        .primary { background:#176554; color:white; }
        .secondary { background:#edf3ef; color:#254840; }
        .quiet { background:transparent; color:#637175; }
        .badge { position:absolute; top:14px; left:14px; z-index:999998; display:flex; align-items:center; gap:7px; border:1px solid rgba(255,255,255,.2); border-radius:99px; padding:8px 11px; background:rgba(15,38,38,.88); color:white; font:700 12px system-ui,sans-serif; box-shadow:0 3px 16px rgba(0,0,0,.18); }
        .badge i { width:8px; height:8px; border-radius:50%; background:#a2e7bf; }
        .badge.review i { background:#ffd078; }
        .badge.blocked i { background:#ff9d8e; }
        @media (max-width:520px) { .card { padding:20px; } h2 { font-size:21px; } }
      </style>
      <div id="surface"></div>`;
    host.appendChild(root);
    return true;
  }

  function pauseVideo() {
    document.querySelector("video")?.pause();
  }

  function goBack() {
    if (history.length > 1) history.back();
    else location.assign("https://www.youtube.com/");
  }

  function resumeVideo() {
    const video = document.querySelector("video");
    if (video?.paused) video.play().catch(() => {});
  }

  function render(decision) {
    if (!ensureOverlay()) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => render(decision), 700);
      return;
    }
    const surface = shadow.getElementById("surface");
    const status = decision?.status || "connecting";
    lastStatus = status;
    if (["off", "allowed_once"].includes(status)) {
      root.remove();
      root = shadow = null;
      resumeVideo();
      return;
    }
    if (status === "safe") {
      surface.innerHTML = `<div class="badge"><i></i>${decision.preview ? "Preview only · no model result" : "Sprout checked this video"}</div>`;
      return;
    }

    pauseVideo();
    const states = {
      connecting: {
        title: "Sprout needs a grown-up to check",
        detail: "Sprout can’t check this video yet. Please ask your grown-up before watching.",
        note: "Your grown-up can check Sprout in the toolbar.",
        icon: "?",
        noteClass: "offline-note"
      },
      review: {
        title: "Let’s pause and ask a grown-up",
        detail: "Your grown-up can check if this video is right for you.",
        note: "You’re doing the right thing by asking for help.",
        icon: "♡",
        noteClass: ""
      },
      blocked: {
        title: "Let’s choose a different video",
        detail: "This video isn’t available for your watching profile.",
        note: "If you have a question, ask your grown-up.",
        icon: "✓",
        noteClass: ""
      }
    };
    const state = states[status] || states.review;
    const previewTag = decision.preview ? '<span class="preview">Preview example · no model result</span>' : "";
    surface.innerHTML = `
      <section class="scrim" role="dialog" aria-modal="true" aria-labelledby="sprout-title" aria-describedby="sprout-detail">
        <div class="card">
          <img class="mascot" src="${chrome.runtime.getURL("assets/sprout-mascot-512.png")}" alt="" aria-hidden="true">
          <div class="brand"><span class="mark">✳</span> Sprout family mode</div>
          <h2 id="sprout-title">${state.title}</h2>
          <p id="sprout-detail">${state.detail}</p>
          <div class="kid-note ${state.noteClass}"><span aria-hidden="true">${state.icon}</span>${state.note}</div>
          ${previewTag}
          <div class="actions">
            <button class="primary" data-action="wait">Ask a grown-up</button>
            <button class="secondary" data-action="back">Go back to videos</button>
          </div>
        </div>
      </section>`;
    surface.querySelector('[data-action="back"]')?.addEventListener("click", goBack);
    surface.querySelector('[data-action="wait"]')?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      chrome.runtime.sendMessage({ type: "request_adult_review", videoId: currentVideoId }).catch(() => {});
      button.textContent = "Please get your grown-up";
      button.disabled = true;
      const note = surface.querySelector(".kid-note");
      if (note) note.innerHTML = '<span aria-hidden="true">♡</span>Your grown-up can open Sprout in the toolbar.';
      surface.querySelector('[data-action="back"]')?.focus();
    });
    surface.querySelector('[data-action="wait"]')?.focus({ preventScroll: true });
  }

  async function refresh() {
    const id = videoIdFromUrl();
    if (!id) {
      root?.remove(); root = shadow = null; currentVideoId = ""; return;
    }
    if (id === currentVideoId && lastStatus) return;
    currentVideoId = id;
    lastStatus = "checking";
    render({ status: "connecting" });
    try {
      const result = await chrome.runtime.sendMessage({ type: "get_decision", videoId: id });
      if (id === videoIdFromUrl()) render(result);
    } catch {
      render({ status: "connecting" });
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "refresh_protection") {
      lastStatus = "";
      refresh();
    }
    if (message?.type === "allow_once" && message.videoId === currentVideoId) {
      render({ status: "allowed_once" });
    }
    if (message?.type === "back_to_results") goBack();
  });

  document.addEventListener("play", (event) => {
    if (event.target instanceof HTMLVideoElement && pauseStatuses.has(lastStatus)) {
      event.target.pause();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!root?.isConnected || !pauseStatuses.has(lastStatus)) return;
    const dialog = shadow?.querySelector('[role="dialog"]');
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...dialog.querySelectorAll("button:not(:disabled)")];
    if (!buttons.length) return;
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && (shadow.activeElement === first || !dialog.contains(shadow.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && shadow.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }, true);

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastStatus = "";
      refresh();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  refresh();
})();
