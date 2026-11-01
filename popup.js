const SUPPORTED_NAMES = [...new Set(SproutSites.SITES.map((site) => site.name))].join(", ");
const DEFAULTS = { setupComplete: false, protectionOn: false, ageBand: "3-5", previewScenario: "off", customRules: [] };
const AGE_LABELS = { "3-5": "Ages 3–5", "6-8": "Ages 6–8", "9-12": "Ages 9–12" };
const $ = (id) => document.getElementById(id);
const extensionMode = typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage;
let renderedRulesKey = null;
let parentControlsUnlocked = false;
let renderedVideo = null; // video key as resolved in render() (embedded players report their own)

async function checkBackend() {
  $("checkBackend").disabled = true;
  $("backendStatus").textContent = "Checking backend connection…";
  try {
    const health = extensionMode ? await chrome.runtime.sendMessage({type: "get_backend_health"}) : null;
    $("backendStatus").textContent = !extensionMode ? "UI preview · no live connection"
      : !health?.ok ? "Backend unavailable. Start Pawse and keep its terminal open."
      : !health.keyConfigured ? "Backend connected. Add your API key to the backend’s .env and restart it."
      : "Backend connected";
  } catch { $("backendStatus").textContent = "Connection unavailable. Reload Pawse and start the backend."; }
  finally { $("checkBackend").disabled = false; }
}
$("checkBackend").addEventListener("click", checkBackend);
checkBackend();

async function getSettings() {
  if (extensionMode) return { ...DEFAULTS, ...(await chrome.runtime.sendMessage({ type: "get_settings" })) };
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("pawse-preview-settings") || "{}") };
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
  else localStorage.setItem("pawse-preview-settings", JSON.stringify(next));
  return next;
}

async function activeVideo() {
  if (!extensionMode) return { id: "preview-video", tabId: null, isSupported: true, siteName: "YouTube" };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const site = tab?.url ? SproutSites.siteFor(tab.url) : null;
  if (!site) return { id: "", tabId: tab?.id, isSupported: false, siteName: "" };
  return { id: SproutSites.videoKey(tab.url), tabId: tab.id, isSupported: true, siteName: site.name };
}

async function getDecision(video) {
  if (!video.isSupported || !video.id) return { status: "none" };
  if (!extensionMode) {
    const settings = await getSettings();
    if (!settings.setupComplete || !settings.protectionOn) return { status: "off" };
    if (sessionStorage.getItem("pawse-allowed-once") === video.id) return { status: "allowed_once", preview: true };
    const states = {
      safe: { status: "safe", preview: true },
      review: { status: "review", preview: true },
      blocked: { status: "blocked", preview: true }
    };
    return states[settings.previewScenario] || { status: "connecting" };
  }
  return chrome.runtime.sendMessage({ type: "get_decision", videoId: video.id, tabId: video.tabId });
}

function describeDecision(decision, settings, video) {
  if (!video.isSupported) return { title: "Site not supported", text: `Pawse works on ${SUPPORTED_NAMES}. Videos here are not checked.`, icon: "↗", kind: "" };
  if (!video.id) return { title: "Choose a video", text: `Open a ${video.siteName} video to check it.`, icon: "•", kind: "" };
  if (!settings.protectionOn) return { title: "Protection is off", text: "Turn it on to check videos.", icon: "○", kind: "" };
  if (decision.status === "safe") return { title: "Pawse says: all clear!", text: decision.preview ? "Just a demo · not a real check." : "Upcoming visual samples checked.", icon: "✓", kind: "good" };
  if (decision.status === "review") return { title: "Pawse time!", text: decision.detail || "Please ask a grown-up to check this video.", icon: "Ⅱ", kind: "review" };
  if (decision.status === "blocked") return { title: "Let’s pause and pick another", text: decision.detail || "Pawse is looking out for you.", icon: "Ⅱ", kind: "blocked" };
  if (decision.status === "checking") return { title: "Checking…", text: "Wait for Pawse to finish.", icon: "…", kind: "review" };
  if (decision.status === "connecting") return { title: "Pawse time!", text: decision.detail || "Let’s ask a grown-up to check this video.", icon: "Ⅱ", kind: "review" };
  if (decision.status === "allowed_once") return { title: "Allowed once", text: "For this session only.", icon: "✓", kind: "good" };
  return { title: "Not connected", text: "Moderation service unavailable.", icon: "…", kind: "" };
}

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("visible");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("visible"), 2000);
}

function renderRules(rules = []) {
  const key = JSON.stringify(rules);
  if (key === renderedRulesKey) return;
  renderedRulesKey = key;
  const list = $("ruleList");
  list.replaceChildren();
  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "rule-empty";
    empty.textContent = "No family rules yet. Add one above.";
    list.append(empty);
    return;
  }
  rules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "rule-item";
    const text = document.createElement("p");
    text.textContent = rule;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-rule";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove rule ${index + 1}`);
    remove.dataset.index = String(index);
    remove.addEventListener("click", async (event) => {
      const ruleIndex = Number(event.currentTarget.dataset.index);
      const current = await getSettings();
      const nextRules = [...(current.customRules || [])];
      nextRules.splice(ruleIndex, 1);
      await saveSettings({ customRules: nextRules });
      refreshTab();
      render();
      toast("Family rule removed.");
    });
    row.append(text, remove);
    list.append(row);
  });
}

async function render() {
  const settings = await getSettings();
  const video = await activeVideo();
  const decision = await getDecision(video);
  // An embedded player (e.g. Dailymotion) reports its own key; act on what is actually playing.
  if (extensionMode && decision?.videoId && SproutSites.isValidKey(decision.videoId)) video.id = decision.videoId;
  renderedVideo = video;
  const adultRequest = extensionMode && video.id
    ? await chrome.runtime.sendMessage({ type: "get_adult_request", videoId: video.id }).catch(() => ({ requested: false }))
    : { requested: false };
  $("setupView").hidden = settings.setupComplete;
  $("dashboardView").hidden = !settings.setupComplete;
  if (!settings.setupComplete) return;
  $("parentUnlockForm").hidden = parentControlsUnlocked;
  $("parentUnlockButton").textContent = settings.pinConfigured ? "Unlock controls" : "Set PIN and unlock";
  document.querySelectorAll(".parent-control").forEach((section) => { section.hidden = !parentControlsUnlocked; });

  $("profileTitle").textContent = AGE_LABELS[settings.ageBand] || AGE_LABELS["3-5"];
  $("ageSelect").value = settings.ageBand;
  $("previewSelect").value = settings.previewScenario;
  document.querySelectorAll("[data-demo-state]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.demoState === settings.previewScenario));
  });
  renderRules(Array.isArray(settings.customRules) ? settings.customRules : []);
  $("protectionToggle").setAttribute("aria-checked", String(settings.protectionOn));
  $("protectionHint").classList.toggle("on", settings.protectionOn);
  $("protectionHint").lastElementChild.textContent = settings.protectionOn ? "Protection is on for supported sites" : "Protection is off";

  const status = describeDecision(decision, settings, video);
  $("videoTitle").textContent = status.title;
  $("decisionText").textContent = status.text;
  $("decisionIcon").textContent = status.icon;
  $("decisionIcon").className = "decision-icon " + status.kind;
  $("checkSummary").textContent = decision.preview
    ? "Demo state · no model result"
    : decision.provenance === "live"
      ? `${decision.frameCount} visual frames · ${decision.apiSeconds}s · checked to ${decision.end.toFixed(1)}s`
      : decision.status === "off" || !settings.protectionOn ? "Protection is off" : "Waiting for a live visual check";
  $("previewLabel").hidden = !decision.preview;
  $("adultRequestLabel").hidden = !adultRequest.requested;
  $("adultRequestLabel").textContent = adultRequest.requested ? "🐾 Pawse let your grown-up know." : "";
  $("allowOnceButton").hidden = !["review", "blocked", "connecting"].includes(decision.status) || !video.id;
  $("allowOnceButton").textContent = decision.status === "connecting" ? "Ask a grown-up" : "Ask a grown-up to approve";
  $("backButton").hidden = !["review", "blocked", "connecting"].includes(decision.status) || !video.id;
  $("pinStatus").textContent = settings.pinConfigured ? "PIN set" : "Set a PIN to approve videos.";
}

$("startButton").addEventListener("click", async () => {
  const settings = await saveSettings({ setupComplete: true, protectionOn: true, ageBand: $("setupAge").value });
  if (extensionMode) {
    const video = await activeVideo();
    if (video.tabId != null) chrome.tabs.sendMessage(video.tabId, { type: "refresh_protection" }).catch(() => {});
  }
  render();
});

$("parentUnlockForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { pinConfigured } = await getSettings();
  const pin = $("parentUnlockPin").value;
  const result = pinConfigured
    ? await chrome.runtime.sendMessage({ type: "verify_parent_pin", pin })
    : await chrome.runtime.sendMessage({ type: "set_parent_pin", pin });
  if (!result?.ok) { toast("That PIN didn’t work. Try again."); $("parentUnlockPin").select(); return; }
  parentControlsUnlocked = true;
  $("parentUnlockPin").value = "";
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

document.querySelectorAll("[data-demo-state]").forEach((button) => {
  button.addEventListener("click", async () => {
    await saveSettings({ previewScenario: button.dataset.demoState });
    refreshTab();
    render();
  });
});

$("ruleInput").addEventListener("input", (event) => {
  $("ruleCharCount").textContent = `${event.target.value.length} / 280`;
});

$("ruleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("ruleInput");
  const rule = input.value.trim();
  if (!rule) { toast("Write a rule first."); input.focus(); return; }
  const current = await getSettings();
  const rules = Array.isArray(current.customRules) ? current.customRules : [];
  if (rules.length >= 10) { toast("You can save up to 10 family rules."); return; }
  if (rules.some((saved) => saved.toLocaleLowerCase() === rule.toLocaleLowerCase())) {
    toast("That rule is already saved."); return;
  }
  await saveSettings({ customRules: [...rules, rule] });
  input.value = "";
  $("ruleCharCount").textContent = "0 / 280";
  refreshTab();
  render();
  toast("Family rule saved.");
});

async function refreshTab() {
  if (!extensionMode) return;
  const video = await activeVideo();
  if (video.tabId != null) chrome.tabs.sendMessage(video.tabId, { type: "refresh_protection" }).catch(() => {});
}

$("allowOnceButton").addEventListener("click", async () => {
  $("approvalForm").hidden = false;
  $("approvalPin").focus();
});

$("approvalForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const video = renderedVideo || await activeVideo();
  const result = await chrome.runtime.sendMessage({ type: "allow_once", videoId: video.id, tabId: video.tabId, pin: $("approvalPin").value });
  if (!result?.ok) { toast("That PIN didn’t work. Try again."); $("approvalPin").select(); return; }
  $("approvalPin").value = "";
  $("approvalForm").hidden = true;
  toast("Approved for this session.");
  render();
});

$("pinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await chrome.runtime.sendMessage({ type: "set_parent_pin", pin: $("newPin").value, currentPin: $("currentPin").value });
  if (!result?.ok) { toast(result?.error === "current_pin" ? "Enter the current PIN to change it." : "Use 4–8 digits for the PIN."); return; }
  $("currentPin").value = "";
  $("newPin").value = "";
  toast("Parent PIN saved.");
  render();
});

$("backButton").addEventListener("click", async () => {
  const video = await activeVideo();
  if (extensionMode && video.tabId != null) {
    if (video.id) await chrome.runtime.sendMessage({ type: "clear_adult_request", videoId: video.id, tabId: video.tabId });
    await chrome.runtime.sendMessage({ type: "back_to_results", tabId: video.tabId });
  }
  else toast("In the extension, this goes back to the previous page.");
});

function showHelp() { $("helpDialog").showModal(); }
$("helpButton").addEventListener("click", showHelp);
$("closeHelp").addEventListener("click", () => $("helpDialog").close());
$("doneHelp").addEventListener("click", () => $("helpDialog").close());

render();
if (extensionMode) setInterval(render, 1800);
