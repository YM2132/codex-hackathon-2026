importScripts("sites.js");

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

async function decide(videoId, tabId, fromPopup = false) {
  if (!SproutSites.isValidKey(videoId)) return {videoId, status: "off", preview: false};
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

  const saved = await chrome.storage.session.get(`decision:${tabId}`);
  const recent = saved[`decision:${tabId}`];
  // The popup derives its key from the tab URL; an embedded player (Dailymotion) reports its own key.
  if (recent && (recent.videoId === videoId || fromPopup) && Date.now() - recent.updatedAt < 5000) return recent;
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
    if (message?.type === "classify_frames") {
      if (!SproutSites.isValidKey(message.scan?.videoId || "")) throw new Error("Invalid video key");
      const prefs = await settings();
      if (!prefs.setupComplete || !prefs.protectionOn || prefs.previewScenario !== "off") {
        sendResponse({ok: false, error: "Live checks are disabled"}); return;
      }
      const response = await fetch("http://127.0.0.1:8000/classify", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({...message.scan, ageBand: prefs.ageBand, customRules: prefs.customRules}),
        signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) throw new Error(`Backend HTTP ${response.status}`);
      sendResponse(await response.json()); return;
    }
    if (message?.type === "report_decision" && sender.tab) {
      await chrome.storage.session.set({[`decision:${sender.tab.id}`]: {...message.decision, updatedAt: Date.now()}});
      sendResponse({ok: true}); return;
    }
    if (message?.type === "get_settings") {
      sendResponse(await settings());
      return;
    }
    if (message?.type === "save_settings") {
      const prefs = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
      await chrome.storage.sync.set(prefs);
      await chrome.storage.session.set({ allowedVideoIds: [] });
      // Every supported site, without needing the "tabs" permission: tabs without Pawse ignore it.
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {type: "refresh_protection"}).catch(() => {})));
      sendResponse(prefs);
      return;
    }
    if (message?.type === "get_decision") {
      sendResponse(await decide(String(message.videoId || ""), sender.tab?.id ?? message.tabId, !sender.tab));
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
      const videoId = String(message.videoId || "");
      const saved = await chrome.storage.session.get("allowedVideoIds");
      // A feed page key would allow every later video on that page, so it is not remembered;
      // the content script allows only the video currently playing.
      const allowedVideoIds = SproutSites.isPageKey(videoId)
        ? (saved.allowedVideoIds || []) : [...new Set([...(saved.allowedVideoIds || []), videoId])];
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
  })().catch(() => sendResponse({ ok: false, error: "Pawse cannot reach the Decisions service. Start the local backend and retry." }));
  return true;
});
