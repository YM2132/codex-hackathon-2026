const DEFAULT_SETTINGS = {
  setupComplete: false,
  protectionOn: false,
  ageBand: "3-5",
  previewScenario: "off",
  customRules: []
};

const PREVIEW_STATES = {
  safe: {
    status: "safe",
    preview: true,
    title: "Looks okay for this profile",
    detail: "No adult review is needed in this preview."
  },
  review: {
    status: "review",
    preview: true,
    title: "A grown-up should check this one",
    detail: "Playback is paused until an adult decides."
  },
  blocked: {
    status: "blocked",
    preview: true,
    title: "Paused for this profile",
    detail: "This preview state keeps the video paused."
  }
};

async function settings() {
  const saved = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...saved };
}

async function derivePin(pin, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" }, material, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyPin(pin) {
  const { parentPin } = await chrome.storage.local.get("parentPin");
  if (!parentPin?.salt || !parentPin?.hash) return false;
  return (await derivePin(pin, Uint8Array.from(parentPin.salt))).toLowerCase() === parentPin.hash;
}

async function decide(videoId) {
  const prefs = await settings();
  if (!prefs.setupComplete || !prefs.protectionOn) {
    return { videoId, status: "off", preview: false };
  }

  const allowed = await chrome.storage.session.get("allowedVideoIds");
  if ((allowed.allowedVideoIds || []).includes(videoId)) {
    return { videoId, status: "allowed_once", preview: prefs.previewScenario !== "off" };
  }

  if (prefs.previewScenario !== "off") {
    return { videoId, ...(PREVIEW_STATES[prefs.previewScenario] || PREVIEW_STATES.review) };
  }

  return {
    videoId,
    status: "connecting",
    preview: false,
    title: "Protection is on",
    detail: "The moderation service is not connected yet."
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
  await chrome.storage.session.set({ allowedVideoIds: [] });
  await chrome.storage.session.set({ adultRequests: {} });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "get_settings") {
      const prefs = await settings();
      const { parentPin } = await chrome.storage.local.get("parentPin");
      sendResponse({ ...prefs, pinConfigured: Boolean(parentPin?.hash) });
      return;
    }
    if (message?.type === "set_parent_pin") {
      if (sender.tab || !/^\d{4,8}$/.test(String(message.pin || ""))) {
        sendResponse({ ok: false }); return;
      }
      const { parentPin: existingPin } = await chrome.storage.local.get("parentPin");
      if (existingPin?.hash && !(await verifyPin(String(message.currentPin || "")))) {
        sendResponse({ ok: false, error: "current_pin" }); return;
      }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await derivePin(String(message.pin), salt);
      await chrome.storage.local.set({ parentPin: { salt: Array.from(salt), hash } });
      sendResponse({ ok: true }); return;
    }
    if (message?.type === "save_settings") {
      const prefs = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
      await chrome.storage.sync.set(prefs);
      if (sender.tab?.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, { type: "refresh_protection" }).catch(() => {});
      }
      sendResponse(prefs);
      return;
    }
    if (message?.type === "get_decision") {
      sendResponse(await decide(String(message.videoId || "")));
      return;
    }
    if (message?.type === "request_adult_review") {
      const videoId = String(message.videoId || "");
      const tabId = sender.tab?.id;
      const saved = await chrome.storage.session.get("adultRequests");
      const adultRequests = { ...(saved.adultRequests || {}), [videoId]: tabId ?? null };
      await chrome.storage.session.set({ adultRequests });
      if (tabId != null) {
        await chrome.action.setBadgeBackgroundColor({ color: "#a66b16", tabId });
        await chrome.action.setBadgeText({ text: "!", tabId });
      }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "get_adult_request") {
      const saved = await chrome.storage.session.get("adultRequests");
      sendResponse({ requested: Object.hasOwn(saved.adultRequests || {}, String(message.videoId || "")) });
      return;
    }
    if (message?.type === "clear_adult_request") {
      const videoId = String(message.videoId || "");
      const saved = await chrome.storage.session.get("adultRequests");
      const adultRequests = { ...(saved.adultRequests || {}) };
      const tabId = adultRequests[videoId] ?? message.tabId;
      delete adultRequests[videoId];
      await chrome.storage.session.set({ adultRequests });
      if (tabId != null) await chrome.action.setBadgeText({ text: "", tabId });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "allow_once") {
      if (sender.tab || !(await verifyPin(String(message.pin || "")))) {
        sendResponse({ ok: false, error: "pin" }); return;
      }
      const videoId = String(message.videoId || "");
      const saved = await chrome.storage.session.get("allowedVideoIds");
      const allowedVideoIds = [...new Set([...(saved.allowedVideoIds || []), videoId])];
      await chrome.storage.session.set({ allowedVideoIds });
      const requests = await chrome.storage.session.get("adultRequests");
      const adultRequests = { ...(requests.adultRequests || {}) };
      delete adultRequests[videoId];
      await chrome.storage.session.set({ adultRequests });
      if (message.tabId != null) await chrome.action.setBadgeText({ text: "", tabId: message.tabId });
      if (message.tabId != null) {
        await chrome.tabs.sendMessage(message.tabId, { type: "allow_once", videoId }).catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "back_to_results") {
      if (message.tabId != null) {
        await chrome.tabs.sendMessage(message.tabId, { type: "back_to_results" }).catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false });
  })().catch(() => sendResponse({ ok: false }));
  return true;
});

/*
 * Algorithm team integration contract:
 * replace the preview branch in decide() with a call that accepts videoId and
 * the selected ageBand and customRules, then returns
 * {status, title, detail, preview:false}. Custom rules are parent-authored
 * plain-language preferences stored in chrome.storage.sync.
 * Keep provider credentials out of this extension package; call an authenticated
 * team service or a protected backend instead of embedding an API key here.
 */
