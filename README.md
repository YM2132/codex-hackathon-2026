# Pawse family mode — YouTube extension prototype

Pawse adds a parent-controlled pause and review flow to YouTube. This branch focuses on the interface and demo path; it does not call a moderation model yet. The YouTube companion uses four transparent dog sprites: idle, thinking, greeting, and pause. The matching pose appears in its helper panel and pause card; the toolbar uses a matching cutout icon.

## Parent and child flow

1. On first open, a parent chooses an age range and turns protection on.
2. A child opens a YouTube video. The extension content script asks the service worker for the video decision.
3. Until the algorithm service is connected, the page shows a clear connection state. The popup's **Preview the experience** menu can switch among sample states for a demo; each sample is labeled and does not represent a model prediction.
4. Review, blocked, and service-unavailable states pause playback and show Pawse with a short, child-friendly next step. The child can ask a grown-up (which adds a toolbar badge) or go back to videos.
5. The parent opens the Pawse toolbar popup to see the state and any help request. They can allow the current video once, go back, or change the age profile or protection setting.
6. Parents can add up to ten plain-language family rules in the popup. The rules are saved in Chrome sync settings for the algorithm service to consume when it is connected.

## Load in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this repository folder.
4. Pin the Pawse icon, visit a YouTube video, and open the extension popup.
5. Choose **Set up protection**, then expand **Preview the experience** and select a sample state to walk through the flow. The preview is labeled and does not represent a model prediction. With protection enabled but no service connected, playback pauses and Pawse asks for a grown-up.

## Algorithm handoff

The adapter point is `decide()` in `service-worker.js`. It currently returns either a non-connected state or an explicit preview state. Replace the non-connected branch with the team's service call using the video ID, age band, and parent-authored `customRules`. The UI contract is:

```js
{ status: "safe" | "review" | "blocked", preview: false }
```

The extension stores only the current session's one-video override in `chrome.storage.session`. Keep API credentials on a protected server; do not ship them in this extension. The UI copy should stay categorical and avoid exposing image descriptions to children.

## Local UI preview

Open `popup.html` directly in a browser for the popup flow. In that mode, settings are stored in local browser storage and the sample selector works without Chrome extension APIs. On YouTube, load the unpacked extension for the player overlay and one-time parent override flow.

## Dividing Responsibilities

### Product

1. Designing a child-friendly interface to the Chrome extension, eg. OpenAI Pets for Kids
2. Ensuring the extension reroutes back to a safe page
3. Using the models to detect if what the child is seeing should be blocked via pop-up
4. Create a demo
### Modelling

1. Downloading a benchmark for evaluating content safety filters for children, specifically focused on Youtube videos.
2. Evaluating OpenAI stack on this benchmark to assess viability
3. Optimizing inference using metadata + avoid downloading videos. How can we get reliable performance while minimizing the cost of OpenAI calls? 
