(() => {
  if (window.__pawseProtectionLoaded) return;
  window.__pawseProtectionLoaded = true;

  let currentVideoId = "";
  let root;
  let shadow;
  let lastStatus = "";
  let refreshTimer;
  let buddyHost;
  let buddyShadow;
  let buddyPanelOpen = false;
  const pauseStatuses = new Set(["connecting", "review", "blocked"]);
  const buddySprites = {
    idle: "assets/pawse-idle-cutout.png",
    thinking: "assets/pawse-thinking-cutout.png",
    greeting: "assets/pawse-greeting-cutout.png",
    pause: "assets/pawse-pause-cutout.png"
  };

  function videoIdFromUrl() {
    const url = new URL(location.href);
    if (url.pathname === "/watch") return url.searchParams.get("v") || "";
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    return "";
  }

  function player() {
    return document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
  }

  function ensureBuddy() {
    if (buddyHost?.isConnected) return;
    buddyHost = document.createElement("div");
    buddyHost.id = "pawse-buddy-root";
    buddyShadow = buddyHost.attachShadow({ mode: "open" });
    buddyShadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; right:20px; bottom:20px; z-index:2147483000; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        :host([hidden]) { display:none !important; }
        * { box-sizing:border-box; }
        .pet { display:grid; width:128px; height:128px; place-items:center; overflow:visible; padding:0; border:0; border-radius:0; background:transparent; filter:drop-shadow(0 3px 3px #51361e22); cursor:pointer; animation:buddy-bob 3.2s ease-in-out infinite; }
        .pet img { width:128px; height:128px; object-fit:contain; transition:transform .2s ease; }
        .pet:hover img { transform:scale(1.025); }
        .pet:focus-visible,.close:focus-visible,.action:focus-visible { outline:3px solid #70c7a4; outline-offset:3px; }
        @keyframes buddy-bob { 0%,100% { transform:translateY(1px); } 50% { transform:translateY(-4px); } }
        @media (prefers-reduced-motion: reduce) { .pet,.pet img { animation:none !important; transition:none; } }
        .panel { position:absolute; right:8px; bottom:126px; width:min(276px,calc(100vw - 28px)); padding:16px; border:1px solid #e8e3d9; border-radius:16px; background:#fffdf8; color:#183a3c; box-shadow:0 12px 36px #102a2b28; }
        .panel[hidden] { display:none !important; }
        .panel-head { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
        .mini-pet { width:48px; height:48px; flex:0 0 48px; object-fit:contain; }
        .panel-title { margin:0; color:#17333b; font-size:15px; font-weight:750; line-height:1.25; }
        .panel-detail { margin:0; color:#5d6c70; font-size:12px; line-height:1.5; }
        .panel-detail[aria-live] { speak:normal; }
        .panel-actions { display:grid; gap:7px; margin-top:13px; }
        .action { min-height:38px; border:0; border-radius:11px; background:#176554; color:white; font:700 12px system-ui,sans-serif; cursor:pointer; }
        .action.secondary { background:#edf3ef; color:#254840; }
        .close { position:absolute; top:8px; right:9px; width:27px; height:27px; border:0; border-radius:50%; background:transparent; color:#637175; font:20px system-ui,sans-serif; cursor:pointer; }
      </style>
      <button class="pet" id="buddyToggle" data-mood="idle" aria-label="Open Pawse helper" aria-expanded="false"><img alt=""></button>
      <section class="panel" id="buddyPanel" role="dialog" aria-label="Pawse helper" aria-live="polite" hidden>
        <button class="close" id="buddyClose" aria-label="Close Pawse helper">×</button>
        <div class="panel-head"><img class="mini-pet" alt=""><h2 class="panel-title" id="buddyTitle"></h2></div>
        <p class="panel-detail" id="buddyDetail"></p>
        <div class="panel-actions">
          <button class="action" id="buddyAsk">Ask a grown-up</button>
          <button class="action secondary" id="buddyBack">Go back to videos</button>
        </div>
      </section>`;
    const mascotUrl = chrome.runtime.getURL(buddySprites.idle);
    buddyShadow.querySelectorAll("img").forEach((img) => { img.src = mascotUrl; });
    document.documentElement.appendChild(buddyHost);
    const toggle = buddyShadow.getElementById("buddyToggle");
    const panel = buddyShadow.getElementById("buddyPanel");
    toggle.addEventListener("click", () => {
      buddyPanelOpen = !buddyPanelOpen;
      panel.hidden = !buddyPanelOpen;
      toggle.setAttribute("aria-expanded", String(buddyPanelOpen));
      if (buddyPanelOpen && !pauseStatuses.has(lastStatus)) setBuddyMood("greeting", "Hi!");
      else updateBuddyMood();
    });
    buddyShadow.getElementById("buddyClose").addEventListener("click", closeBuddyPanel);
    buddyShadow.getElementById("buddyAsk").addEventListener("click", (event) => requestAdultHelp(event.currentTarget));
    buddyShadow.getElementById("buddyBack").addEventListener("click", goBack);
  }

  function closeBuddyPanel() {
    buddyPanelOpen = false;
    if (!buddyShadow) return;
    buddyShadow.getElementById("buddyPanel").hidden = true;
    buddyShadow.getElementById("buddyToggle").setAttribute("aria-expanded", "false");
    updateBuddyMood();
  }

  function setBuddyMood(mood, label) {
    const pet = buddyShadow?.getElementById("buddyToggle");
    if (!pet) return;
    pet.dataset.mood = mood;
    pet.setAttribute("aria-label", `Pawse: ${label}. Open helper.`);
    const spriteUrl = chrome.runtime.getURL(buddySprites[mood] || buddySprites.idle);
    buddyShadow.querySelectorAll(".pet img, .mini-pet").forEach((image) => { image.src = spriteUrl; });
  }

  function updateBuddyMood() {
    if (lastStatus === "connecting" || lastStatus === "checking") setBuddyMood("thinking", "Hmm…");
    else if (pauseStatuses.has(lastStatus)) setBuddyMood("pause", "Pause");
    else if (buddyPanelOpen) setBuddyMood("greeting", "Hi!");
    else setBuddyMood("idle", "Ready");
  }

  function updateBuddy(status, decision = {}) {
    ensureBuddy();
    if (status === "off") {
      buddyHost.hidden = true;
      closeBuddyPanel();
      return;
    }
    buddyHost.hidden = false;
    updateBuddyMood();
    const copy = status === "safe"
      ? { title: "All clear!", detail: decision.preview ? "Just a demo." : "You’re good to go." }
      : status === "connecting"
        ? { title: "Pawse time!", detail: "Let’s ask a grown-up to check." }
      : status === "review" || status === "blocked"
        ? { title: "Pawse time!", detail: "Please ask a grown-up to help." }
      : status === "no_video"
        ? { title: "Hi, I’m Pawse.", detail: "Open a video to check it." }
        : { title: "Hi, I’m Pawse.", detail: "Here to help." };
    buddyShadow.getElementById("buddyTitle").textContent = copy.title;
    buddyShadow.getElementById("buddyDetail").textContent = copy.detail;
    buddyShadow.getElementById("buddyAsk").hidden = status !== "safe" && !pauseStatuses.has(status);
    buddyShadow.getElementById("buddyBack").hidden = status !== "safe" && !pauseStatuses.has(status);
    buddyShadow.getElementById("buddyAsk").textContent = "Ask a grown-up";
  }

  function requestAdultHelp(button) {
    if (!currentVideoId) return;
    chrome.runtime.sendMessage({ type: "request_adult_review", videoId: currentVideoId }).catch(() => {});
    if (button) {
      button.textContent = "Please get your grown-up";
      button.disabled = true;
      setBuddyMood("pause", "Ask a grown-up");
    }
  }

  function ensureOverlay() {
    const host = player();
    if (!host) return false;
    if (root?.isConnected && root.parentElement === host) return true;
    root?.remove();
    root = document.createElement("div");
    root.id = "pawse-protection-root";
    root.setAttribute("aria-live", "polite");
    shadow = root.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position:absolute; inset:0; z-index:999999; display:block; pointer-events:auto; }
        .scrim { position:absolute; inset:0; z-index:999999; display:grid; place-items:center; padding:20px; box-sizing:border-box; background:rgba(14,25,38,.78); color:#172b35; font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        .card { width:min(440px,100%); box-sizing:border-box; padding:24px; border-radius:22px; background:#fffdf8; box-shadow:0 18px 64px rgba(0,0,0,.28); }
        .mascot { display:block; width:112px; height:112px; margin:0 auto 14px; object-fit:contain; animation:pawse-float 3.2s ease-in-out infinite; }
        @keyframes pawse-float { 0%,100% { transform:translateY(2px); } 50% { transform:translateY(-3px); } }
        @media (prefers-reduced-motion: reduce) { .mascot { animation:none; } }
        h2 { margin:0 0 8px; color:#17333b; font-size:23px; line-height:1.18; letter-spacing:-.03em; }
        p { margin:0; color:#5d6c70; font-size:14px; }
        .preview { display:inline-flex; margin-top:15px; padding:5px 9px; border-radius:99px; background:#fff3d8; color:#725112; font-size:11px; font-weight:700; }
        .actions { display:flex; flex-direction:column; gap:9px; margin-top:22px; }
        button { min-height:44px; border:0; border-radius:13px; padding:0 14px; font:700 14px system-ui,sans-serif; cursor:pointer; }
        .primary { background:#2b6967; color:white; }
        .secondary { background:#edf2e8; color:#315858; }
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
    updateBuddy(status, decision);
    if (["off", "allowed_once"].includes(status)) {
      root.remove();
      root = shadow = null;
      resumeVideo();
      return;
    }
    if (status === "safe") {
      surface.innerHTML = `<div class="badge"><i></i>${decision.preview ? "Preview only · no model result" : "Pawse checked this video"}</div>`;
      return;
    }

    pauseVideo();
    const states = {
      connecting: {
        title: "Pawse time!",
        detail: "Let’s ask a grown-up to check this video."
      },
      review: {
        title: "Pawse time!",
        detail: "Let’s ask a grown-up to check this video."
      },
      blocked: {
        title: "Let’s pause and pick another",
        detail: "Pawse is looking out for you."
      }
    };
    const state = states[status] || states.review;
    const previewTag = decision.preview ? '<span class="preview">Preview example · no model result</span>' : "";
    surface.innerHTML = `
      <section class="scrim" role="dialog" aria-modal="true" aria-labelledby="pawse-title" aria-describedby="pawse-detail">
        <div class="card">
          <img class="mascot" src="${chrome.runtime.getURL(buddySprites.pause)}" alt="" aria-hidden="true">
          <h2 id="pawse-title">${state.title}</h2>
          <p id="pawse-detail">${state.detail}</p>
          ${previewTag}
          <div class="actions">
            <button class="primary" data-action="wait">Ask a grown-up</button>
            <button class="secondary" data-action="back">Go back</button>
          </div>
        </div>
      </section>`;
    surface.querySelector('[data-action="back"]')?.addEventListener("click", goBack);
    surface.querySelector('[data-action="wait"]')?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      requestAdultHelp(null);
      button.textContent = "Please get your grown-up";
      button.disabled = true;
      surface.querySelector('[data-action="back"]')?.focus();
    });
    surface.querySelector('[data-action="wait"]')?.focus({ preventScroll: true });
  }

  async function refresh() {
    const id = videoIdFromUrl();
    if (!id) {
      root?.remove(); root = shadow = null; currentVideoId = ""; lastStatus = "";
      const prefs = await chrome.runtime.sendMessage({ type: "get_settings" }).catch(() => ({}));
      updateBuddy(prefs.protectionOn && prefs.setupComplete ? "no_video" : "off");
      return;
    }
    if (id === currentVideoId && lastStatus) return;
    currentVideoId = id;
    lastStatus = "checking";
    render({ status: "checking" });
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
