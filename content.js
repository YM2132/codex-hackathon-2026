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
  let refreshGeneration = 0;
  const engine = new SproutEngine(render);
  const pauseStatuses = new Set(["checking", "connecting", "review", "blocked"]);
  const buddySprites = {
    idle: "assets/pawse-idle-cutout.png",
    thinking: "assets/pawse-thinking-cutout.png",
    greeting: "assets/pawse-greeting-cutout.png",
    pause: "assets/pawse-pause-cutout.png"
  };

  const site = () => SproutSites.siteFor(location.href);
  function videoIdFromUrl() { return SproutSites.videoKey(location.href); }

  // YouTube-style players get the overlay inside the player element. Elsewhere the overlay is a
  // fixed layer kept over the watched video's on-screen box (see trackOverlay).
  function player() {
    return site()?.player?.() || null;
  }
  function trackOverlay() {
    if (!root?.isConnected || root.parentElement !== document.documentElement) return;
    const video = engine.video();
    const r = video?.getBoundingClientRect();
    if (!r || r.width < 2) { root.style.display = "none"; return; }
    Object.assign(root.style, {position: "fixed", inset: "auto", left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`, display: "block", zIndex: "2147482000"});
  }
  setInterval(trackOverlay, 200);

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
        .pet { display:grid; width:128px; height:128px; place-items:center; overflow:visible; padding:0; border:0; border-radius:0; background:transparent; filter:drop-shadow(0 3px 3px #51361e22); cursor:pointer; animation:buddy-wander 7s ease-in-out infinite; }
        .pet img { width:128px; height:128px; object-fit:contain; transition:transform .2s ease; }
        .pet .sprite-loop { display:block; width:128px; height:128px; background-image:url("${chrome.runtime.getURL("assets/pawse-animation-sheet.png")}"); background-size:200% 200%; animation:pet-frames 2.4s steps(1,end) infinite; }
        @keyframes pet-frames { 0%,24% { background-position:0 0; } 25%,49% { background-position:100% 0; } 50%,74% { background-position:0 100%; } 75%,100% { background-position:100% 100%; } }
        .pet:hover img { transform:scale(1.025); }
        .pet:focus-visible,.close:focus-visible,.action:focus-visible { outline:3px solid #70c7a4; outline-offset:3px; }
        @keyframes buddy-wander { 0%,100% { transform:translate(0,0) rotate(0); } 25% { transform:translate(-5px,-7px) rotate(-2deg); } 55% { transform:translate(-2px,1px) rotate(1deg); } 78% { transform:translate(4px,-4px) rotate(2deg); } }
        .pet[data-mood="pause"] { animation:none; }
        .pet[data-mood="thinking"] { animation:buddy-think 2.8s ease-in-out infinite; }
        @keyframes buddy-think { 0%,100% { transform:translateY(0) rotate(0); } 50% { transform:translateY(-4px) rotate(-2deg); } }
        @media (prefers-reduced-motion: reduce) { .pet,.pet img,.pet .sprite-loop { animation:none !important; transition:none; background-position:0 0 !important; } }
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
      <button class="pet" id="buddyToggle" data-mood="idle" aria-label="Open Pawse helper" aria-expanded="false"><span class="sprite-loop" aria-hidden="true"></span><img alt="" hidden></button>
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
    const petLoop = buddyShadow.querySelector(".pet .sprite-loop");
    const petImage = buddyShadow.querySelector(".pet img");
    const animateFrames = mood === "idle" || mood === "greeting";
    petLoop.hidden = !animateFrames;
    petImage.hidden = animateFrames;
    petImage.src = spriteUrl;
    buddyShadow.querySelector(".mini-pet").src = spriteUrl;
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
      ? { title: "All clear!", detail: decision.preview ? "Just a demo." : "The next few seconds are checked." }
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
    const host = player() || (engine.video() ? document.documentElement : null);
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
        .pet-play { display:block; width:132px; height:132px; margin:0 auto 10px; padding:0; border:0; background:transparent; cursor:pointer; }
        .pet-play .sprite-loop { display:block; width:112px; height:112px; margin:auto; background-image:url("${chrome.runtime.getURL("assets/pawse-animation-sheet.png")}"); background-size:200% 200%; animation:pet-frames 2.4s steps(1,end) infinite; }
        .pet-play:focus-visible { outline:3px solid #70c7a4; outline-offset:2px; border-radius:18px; }
        .pet-play.playing .sprite-loop { animation:pet-frames 1.1s steps(1,end) infinite; }
        .play-feedback { min-height:18px; margin:-4px 0 4px; color:#526965; text-align:center; font-size:12px; }
        @keyframes pawse-float { 0%,100% { transform:translateY(2px); } 50% { transform:translateY(-3px); } }
        @media (prefers-reduced-motion: reduce) { .mascot,.pet-play .sprite-loop { animation:none; background-position:0 0; } }
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
    trackOverlay();
    return true;
  }

  function pauseVideo() {
    (engine.video() || document.querySelector("video"))?.pause();
  }

  function goBack() {
    if (history.length > 1) history.back();
    else location.assign(site()?.home || "https://www.youtube.com/");
  }

  function render(decision) {
    lastStatus = decision?.status || "connecting";
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
      return;
    }
    root.style.pointerEvents = status === "safe" ? "none" : "auto";
    if (status === "safe") {
      surface.innerHTML = `<div class="badge"><i></i>${decision.preview ? "Preview only · no model result" : "Pawse · checking ahead"}</div>`;
      return;
    }

    pauseVideo();
    const states = {
      connecting: {
        title: "Pawse is checking ahead",
        detail: "One moment while Pawse checks the next few seconds."
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
          <button class="pet-play" type="button" aria-label="Play with Pawse"><span class="sprite-loop" aria-hidden="true"></span></button>
          <p class="play-feedback" aria-live="polite">Tap Pawse to say hello</p>
          <h2 id="pawse-title">${state.title}</h2>
          <p id="pawse-detail">${state.detail}</p>
          ${previewTag}
          <div class="actions">
            <button class="primary" data-action="wait">Ask a grown-up</button>
            <button class="secondary" data-action="back">Go back</button>
          </div>
        </div>
      </section>`;
    if (decision.detail) surface.querySelector("#pawse-detail").textContent = decision.detail;
    surface.querySelector('[data-action="back"]')?.addEventListener("click", goBack);
    const petPlay = surface.querySelector(".pet-play");
    let playTaps = 0;
    petPlay?.addEventListener("click", () => {
      playTaps += 1;
      petPlay.classList.remove("playing");
      void petPlay.offsetWidth;
      petPlay.classList.add("playing");
      const feedback = surface.querySelector(".play-feedback");
      feedback.textContent = playTaps >= 3 ? "Pawse says: thanks for keeping me company!" : "Boop! Pawse is happy you’re here.";
      if (playTaps >= 3) playTaps = 0;
    });
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
    const generation = ++refreshGeneration;
    clearTimeout(refreshTimer);
    const id = videoIdFromUrl();
    currentVideoId = id;
    engine.reset(id);
    if (!id) {
      root?.remove(); root = shadow = null; lastStatus = "";
    }
    try {
      const prefs = await chrome.runtime.sendMessage({type: "get_settings"});
      if (generation !== refreshGeneration) return;
      if (!id) { updateBuddy("off"); return; }
      const decision = await chrome.runtime.sendMessage({type: "get_decision", videoId: id});
      if (generation !== refreshGeneration) return;
      if (!prefs.setupComplete || !prefs.protectionOn) engine.reset(id, "off");
      else if (decision.status === "allowed_once") engine.reset(id, "allowed_once");
      else if (prefs.previewScenario !== "off") engine.reset(id, prefs.previewScenario, true);
      else engine.reset(id, "live");
    } catch { engine.reset(id, "connecting"); }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "refresh_protection") {
      lastStatus = "";
      refresh();
    }
    if (message?.type === "allow_once" && message.videoId === currentVideoId) {
      engine.resumeAfterCheck = true;
      engine.reset(currentVideoId, "allowed_once");
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

  document.addEventListener("yt-navigate-start", () => {
    ++refreshGeneration; clearTimeout(refreshTimer); engine.reset("");
    root?.remove(); root = shadow = null;
  });
  document.addEventListener("yt-navigate-finish", refresh);
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastStatus = "";
      refresh();
    }
  }).observe(document, { childList: true, subtree: true });
  refresh();
})();
