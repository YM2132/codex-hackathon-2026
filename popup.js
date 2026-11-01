const DEFAULTS = { setupComplete: false, protectionOn: false, ageBand: "3-5", previewScenario: "off" };
const AGE_LABELS = { "3-5": "Ages 3–5", "6-8": "Ages 6–8", "9-12": "Ages 9–12" };
const $ = (id) => document.getElementById(id);
const extensionMode = typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage;

async function getSettings() {
  if (extensionMode) return { ...DEFAULTS, ...(await chrome.runtime.sendMessage({ type: "get_settings" })) };
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("sprout-preview-settings") || "{}") };
    const demo = new URLSearchParams(location.search).get("demo");
    if (["safe", "review", "blocked"].includes(demo)) {
      return { ...saved, setupComplete: true, protectionOn: true, previewScenario: demo };
    }
    return saved;
  }
  catch { return { ...DEFAULTS }; }
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (extensionMode) await chrome.runtime.sendMessage({ type: "save_settings", settings: next });
  else localStorage.setItem("sprout-preview-settings", JSON.stringify(next));
  return next;
}

async function activeVideo() {
  if (!extensionMode) return { id: "preview-video", tabId: null, isYoutube: true };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return { id: "", tabId: tab?.id, isYoutube: false };
  try {
    const url = new URL(tab.url);
    const id = url.searchParams.get("v") || (url.pathname.startsWith("/shorts/") ? url.pathname.split("/")[2] : "");
    return { id: id || "", tabId: tab.id, isYoutube: url.hostname.endsWith("youtube.com") };
  } catch { return { id: "", tabId: tab?.id, isYoutube: false }; }
}

async function getDecision(video) {
  if (!video.isYoutube || !video.id) return { status: "none" };
  if (!extensionMode) {
    const settings = await getSettings();
    if (!settings.setupComplete || !settings.protectionOn) return { status: "off" };
    if (sessionStorage.getItem("sprout-allowed-once") === video.id) return { status: "allowed_once", preview: true };
    const states = {
      safe: { status: "safe", preview: true },
      review: { status: "review", preview: true },
      blocked: { status: "blocked", preview: true }
    };
    return states[settings.previewScenario] || { status: "connecting" };
  }
  return chrome.runtime.sendMessage({ type: "get_decision", videoId: video.id });
}

function describeDecision(decision, settings, video) {
  if (!video.isYoutube) return { title: "Open YouTube", text: "Protection status appears when you visit a YouTube video.", icon: "↗", kind: "" };
  if (!video.id) return { title: "No video open", text: "Open a video to see its protection status here.", icon: "•", kind: "" };
  if (!settings.protectionOn) return { title: "Protection is off", text: "Turn it on to use the selected profile on YouTube.", icon: "○", kind: "" };
  if (decision.status === "safe") return { title: "Looks okay for this profile", text: decision.preview ? "Preview only: this is not a model result." : "Sprout checked this video for this profile.", icon: "✓", kind: "good" };
  if (decision.status === "review") return { title: "A grown-up should check this one", text: "Playback is paused until an adult chooses what to do.", icon: "!", kind: "review" };
  if (decision.status === "blocked") return { title: "Paused for this profile", text: "This sample state keeps playback paused.", icon: "Ⅱ", kind: "blocked" };
  if (decision.status === "connecting") return { title: "Sprout can’t check yet", text: "Playback stays paused until a grown-up checks or the moderation service is connected.", icon: "?", kind: "review" };
  if (decision.status === "allowed_once") return { title: "Allowed for this video", text: "Playback can continue for this video only.", icon: "✓", kind: "good" };
  return { title: "Model not connected yet", text: "Protection is on. The team’s moderation service will provide video decisions here.", icon: "…", kind: "" };
}

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("visible");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("visible"), 2000);
}

async function render() {
  const settings = await getSettings();
  const video = await activeVideo();
  const decision = await getDecision(video);
  const adultRequest = extensionMode && video.id
    ? await chrome.runtime.sendMessage({ type: "get_adult_request", videoId: video.id }).catch(() => ({ requested: false }))
    : { requested: false };
  $("setupView").hidden = settings.setupComplete;
  $("dashboardView").hidden = !settings.setupComplete;
  if (!settings.setupComplete) return;

  $("profileTitle").textContent = AGE_LABELS[settings.ageBand] || AGE_LABELS["3-5"];
  $("ageSelect").value = settings.ageBand;
  $("previewSelect").value = settings.previewScenario;
  $("protectionToggle").setAttribute("aria-checked", String(settings.protectionOn));
  $("protectionHint").classList.toggle("on", settings.protectionOn);
  $("protectionHint").lastElementChild.textContent = settings.protectionOn ? "Protection is on for YouTube" : "Protection is off";

  const status = describeDecision(decision, settings, video);
  $("videoTitle").textContent = status.title;
  $("decisionText").textContent = status.text;
  $("decisionIcon").textContent = status.icon;
  $("decisionIcon").className = "decision-icon " + status.kind;
  $("previewLabel").hidden = !decision.preview;
  $("adultRequestLabel").hidden = !adultRequest.requested;
  $("allowOnceButton").hidden = !["review", "blocked", "connecting"].includes(decision.status) || !video.id;
  $("backButton").hidden = !["review", "blocked", "connecting"].includes(decision.status) || !video.id;
}

$("startButton").addEventListener("click", async () => {
  const settings = await saveSettings({ setupComplete: true, protectionOn: true, ageBand: $("setupAge").value });
  if (extensionMode) {
    const video = await activeVideo();
    if (video.tabId != null) chrome.tabs.sendMessage(video.tabId, { type: "refresh_protection" }).catch(() => {});
  }
  render();
});

$("protectionToggle").addEventListener("click", async () => {
  const s = await getSettings();
  await saveSettings({ protectionOn: !s.protectionOn });
  refreshTab(); render();
});

$("ageSelect").addEventListener("change", async (event) => {
  await saveSettings({ ageBand: event.target.value });
  refreshTab(); render();
});

$("previewSelect").addEventListener("change", async (event) => {
  await saveSettings({ previewScenario: event.target.value });
  refreshTab(); render();
});

async function refreshTab() {
  if (!extensionMode) return;
  const video = await activeVideo();
  if (video.tabId != null) chrome.tabs.sendMessage(video.tabId, { type: "refresh_protection" }).catch(() => {});
}

$("allowOnceButton").addEventListener("click", async () => {
  const video = await activeVideo();
  if (extensionMode && video.id && video.tabId != null) {
    await chrome.runtime.sendMessage({ type: "allow_once", videoId: video.id, tabId: video.tabId });
  } else if (!extensionMode) {
    sessionStorage.setItem("sprout-allowed-once", video.id);
  }
  toast("Allowed once. This choice ends with the current session.");
  render();
});

$("backButton").addEventListener("click", async () => {
  const video = await activeVideo();
  if (extensionMode && video.tabId != null) {
    if (video.id) await chrome.runtime.sendMessage({ type: "clear_adult_request", videoId: video.id, tabId: video.tabId });
    await chrome.runtime.sendMessage({ type: "back_to_results", tabId: video.tabId });
  }
  else toast("In the extension, this returns to YouTube results.");
});

function showHelp() { $("helpDialog").showModal(); }
$("helpButton").addEventListener("click", showHelp);
$("closeHelp").addEventListener("click", () => $("helpDialog").close());
$("doneHelp").addEventListener("click", () => $("helpDialog").close());

render();
if (extensionMode) setInterval(render, 1800);
