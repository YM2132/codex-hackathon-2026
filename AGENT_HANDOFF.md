# Pawse integration handoff

Updated 2026-11-01. Implementation baseline: **`feat/multisite-pawse`** (multi-site work on top of `2bfae13` from `feat/unified-sprout-extension`). This document describes the integrated code, not a future architecture proposal.

## Start here

The unified extension combines Raja’s latest Pawse UI, Danyal’s buffered-media capture, and the Decisions experiment. **Supported sites: YouTube watch pages, YouTube Kids, TikTok, Instagram, X, Reddit, Snapchat and Dailymotion** (site adapters in `sites.js`). Other websites, YouTube Shorts and native apps are not supported; Facebook and Twitch were tested and fail because their MediaSource runs in a worker.

```sh
git fetch origin
git switch feat/unified-sprout-extension
git pull --ff-only
uv sync
# Configure OPENAI_API_KEY in your own local .env; never put it in extension code.
uv run uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Load the **repository root** through Chrome → `chrome://extensions` → Developer mode → Load unpacked. Do not load `lookahead/extension` alongside it: that is the older capture-only experiment. Open Pawse, complete setup, enable protection, and select **Ready / No sample state** for live calls. Reload open video tabs after installing or updating; the capture hook needs to run before the player creates its media buffers. Press Play if browser autoplay or the YouTube consent dialog holds playback.

`GET http://127.0.0.1:8000/health` reports whether a key is configured; it does not verify the key’s validity or API access. Each teammate needs their own backend process and configured key. Python ≥3.11 and uv are needed for the backend; Node, npm, ffmpeg and a suitable Chrome executable are also needed for the browser harness. The extension’s runtime does not invoke ffmpeg or yt-dlp.

## Branches and merge guidance

| Source branch | Work already included |
| --- | --- |
| `experiment/youtube-frames-decisions` | Frame classification, strict response parser, clip experiments and latency benchmark through `4c757fd` |
| `lookahead-preview` | Danyal’s MediaSource capture through `ae8eb2b`, plus integration fixes |
| `feat/youtube-protection-extension` | Raja’s Pawse dog UI, sprites and preview states through `143298f` |
| `feat/unified-sprout-extension` | Working integration; `5dab10e` wires the pipeline, `17408c2` merges Pawse and removes the temporary demo restriction |
| `lookahead-preview` (later commits) | Multi-site capture: video↔MediaSource mapping, shadow-DOM players, DRM/worker detection, plain-file decoder, site allowlist, cross-site harness |
| `feat/youtube-protection-extension` (`785853d`–`9729853`) | Explicit “Pawse time” pause copy, animated Pawse sprite with tap-to-play, parent PIN for controls and approvals |
| `feat/multisite-pawse` | This branch: merges all of the above into Pawse and adds `sites.js` adapters for all supported sites |

Start further integration from this branch. If your working branch has additional changes, commit them first and merge `origin/feat/unified-sprout-extension`; resolve conflicts deliberately. Do not replace the integrated files wholesale with earlier UI or capture versions. Do not cherry-pick a merge commit without understanding which parent you need. Keep the existing branch history and teammate changes.

Likely conflict hotspots: `manifest.json`, `content.js`, `popup.*`, `README.md`, and `.gitignore`. Preserve both the new Pawse assets and the live integration contracts below. Keep `.env`, `.venv/`, `artifacts/`, and generated image output ignored. The original local hackathon spec is untracked and describes an older Jev/text/SSE design; it is not the current implementation contract.

## Code map and data flow

```text
Site MediaSource bytes (or a plain video file URL)
  → page-hook.js (MAIN world): separate decoder, future JPEG frames; announces the watched <video>
  → engine.js (isolated world): sample and schedule windows
  → service-worker.js: attach current parent settings, call local backend
  → backend/app.py: one Decisions request per window
  → engine.js + guard.js: hold/resume playback
  → content.js: Pawse card and companion; popup.js: parent controls/status
```

| File | Integration responsibility |
| --- | --- |
| `manifest.json` | MV3 entry point; MAIN hook at `document_start` on each supported site; isolated scripts ordered `sites.js`, `guard.js`, `engine.js`, `content.js`; separate `all_frames` entries for `geo.dailymotion.com`; local backend host permission; Pawse assets |
| `sites.js` | `SproutSites`: per-site hosts, URL → video key, player/ad hooks, home URL; shared key validator. Loaded by content scripts, `importScripts` in the worker, the popup and Node tests |
| `lookahead/extension/page-hook.js` | Copies encoded chunks; maps each `<video>` to its MediaSource (incl. shadow DOM); tracks `SourceBuffer.changeType` per chunk; classifies source (`mse`, `progressive`, `drm`, `worker-mse`); replays into a separate decoder; window-message bridge |
| `guard.js` | URL eligibility and pure timeline policy; exports `SproutGuard` despite the UI rebrand |
| `engine.js` | Exports `SproutEngine`; captures windows, calls worker, discards stale generations, pauses/blurs and resumes when appropriate; on feeds pauses non-watched videos and restarts checks when the watched video changes |
| `content.js` | Pawse dog states and overlay (inside the YouTube player, or a fixed layer tracking the video elsewhere), navigation hooks, engine lifecycle, parent-help actions |
| `service-worker.js` | Settings, HTTP relay, latest per-tab decision, session overrides and help requests |
| `popup.html`, `popup.css`, `popup.js` | Raja’s parent UI and labeled preview controls, live frame/latency summary |
| `backend/app.py` | FastAPI relay, request validation, model prompt, family-rule predicates and age thresholds |
| `experiments/youtube_frames.py` | Shared `QUESTIONS`, `ENDPOINT`, `parse_answers`; also a standalone yt-dlp experiment |

Do not rename the internal `SproutGuard` / `SproutEngine` globals in just one file. The visible product name is Pawse, with `pawse-protection-root` and `pawse-buddy-root` DOM hosts.

## Contracts to preserve

### Capture bridge

Isolated world posts `{tag: "lookahead-req", id, op, args}` to the page. Supported operations are `summary` and `decodeFuture`. The reply is `{tag: "lookahead-res", id, result, error}`. `decodeFuture` takes `{times, maxWidth: 512, quality: 0.75}` and returns `frames` with `requested`, `decodedAt`, `jpeg`, or a per-frame `error`. The engine requires every requested frame and checks decoded timestamps before calling the backend.

`summary().player.kind` reports the watched video's source: `mse`, `progressive` (plain file; decoded by a second CORS-mode `<video>`), `drm`, `worker-mse`, `stream`. The engine holds playback with an explanation for anything it cannot decode. The hook also dispatches a composed `pawse-main-video` event on the watched `<video>` every 250 ms; `engine.js` uses it to reach players inside open shadow roots (Reddit).

**Keep codec-change tracking.** YouTube can create a VP9/WebM SourceBuffer and change it to AV1/MP4 before appending. Replaying using only the initial MIME type caused real capture failures. Also preserve current-media URL mapping, native decoder calls that avoid recapturing our own bytes, and decoder cleanup. Capture must not seek the original player.

### Extension messages

| Message | Payload / response |
| --- | --- |
| `classify_frames` | `{scan: {videoId, start, end, frames}}`; worker adds `ageBand` and `customRules`; returns the backend result or `{ok:false,error}` |
| `report_decision` | `{decision}`; stores latest status by sender tab |
| `get_decision` | `{videoId, tabId?}`; returns off/preview/override/current live status; does not initiate classification |
| `get_settings`, `save_settings` | Settings fields: `setupComplete`, `protectionOn`, `ageBand`, `previewScenario`, `customRules` |
| `refresh_protection` | Worker → content script; invalidate and recheck after settings change |
| `request_adult_review`, `get_adult_request`, `clear_adult_request` | Video-specific help request and toolbar badge |
| `allow_once` | `{videoId, tabId, pin}`; parent override for that video for the browser session. Requires the correct parent PIN and must come from a Pawse extension page (popup), never a content script |
| `set_parent_pin` | `{pin, currentPin?}` (4–8 digits); extension pages only; changing an existing PIN needs `currentPin`. Stored as PBKDF2-SHA-256 hash + salt in `chrome.storage.local` |
| `verify_parent_pin` | `{pin}`; extension pages only; unlocks the popup's parent controls for that popup session |
| `back_to_results` | `{tabId}`; asks the content script to navigate back |

`allow_once` for a feed page key (`<site>:page-…`) is not stored in `allowedVideoIds`; the content script allows only the video playing at the time and resumes checks when the source changes. `get_decision` from the popup returns the tab’s latest decision even if its key differs from the URL-derived one (Dailymotion’s embedded player).

Settings use `chrome.storage.sync`. Latest decisions, help requests, and allowed video IDs use `chrome.storage.session`. Checked windows live in the content controller’s memory; there is no persistent classification database. Settings changes clear overrides and invalidate checked windows. An override is keyed by video ID, not exclusively by tab.

### Backend

`POST http://127.0.0.1:8000/classify` accepts the following shape (JPEG strings abbreviated here; placeholders are not valid input):

```json
{
  "videoId": "XnWESGXnGwY",
  "start": 6,
  "end": 9,
  "ageBand": "6-8",
  "customRules": ["Avoid visible fighting"],
  "frames": [
    {"timestamp": 6.1, "jpeg": "data:image/jpeg;base64,..."},
    {"timestamp": 7.1, "jpeg": "data:image/jpeg;base64,..."},
    {"timestamp": 8.1, "jpeg": "data:image/jpeg;base64,..."}
  ]
}
```

`videoId` is a **video key**: an 11-character YouTube/YouTube Kids ID, or `<site>:<id>` (`[a-z]{1,16}:[A-Za-z0-9_.-]{1,80}`) such as `tiktok:7675478347278863629`; feeds without a per-video URL use `<site>:page-<hash>`. The same pattern is in `sites.js` (`SproutSites.KEY`) and `backend/app.py` (`VIDEO_KEY`); change both together. Windows span at most 3.01 seconds. Frames must be ordered, unique, inside the window, and cover it with gaps no larger than 1.11 seconds, including the edges. The relay accepts 1–5 frames, JPEG data URLs up to 500,000 characters each, and up to ten nonempty rules of at most 280 characters. These are **application limits, not documented OpenAI API limits**.

The response includes `videoId`, `start`, `end`, `status` (`safe`, `review`, `blocked`), `category`, `probability`, `threshold`, `probabilities`, `frameCount`, `apiSeconds`, `model`, `preview:false`, `provenance:"live"`, and `audioAnalyzed:false`. The engine checks identity, bounds, status and provenance before storing the result.

Provider request: `POST https://api.openai.com/v1/decisions`, model **`gpt-6-luna`**, one user message containing timestamp text and all window images, plus named predicate questions. Use the existing working request builder and strict response parser. Missing, duplicate, refused, unexpected, or invalid answers must not become a safe verdict. Provider failures return HTTP 502; missing key returns 503; malformed input returns 422. The worker also handles non-success responses as unavailable.

Provider timeout is 20 seconds; worker fetch timeout is 25 seconds; capture bridge timeout is 15 seconds. Controller retries after errors rather than clearing unchecked content. `apiSeconds` measures the backend provider request/validation path, not total capture-to-playback latency.

## Categories and playback policy

The built-in questions are `violence`, `sexual_content`, `frightening_content`, `dangerous_behavior`, `substance_use`, `hate_or_discrimination`, `visible_profanity`, `political_content`, and `religious_content`. Family rules add `family_rule_0`, `family_rule_1`, etc.

Politics and religion are descriptive tags and excluded from default blocking. A parent-authored family rule can restrict them. Other categories and family-rule predicates compete by maximum probability. Blocking thresholds: ages 3–5 → 0.50; 6–8 → 0.70; 9–12 → 0.85. Review starts at `max(0.30, threshold - 0.20)`; lower scores are safe for the sampled window. These thresholds are prototype policy, not calibrated guarantees. All questions assess visuals; speech, music and audio-only rules are not evaluated.

Windows are three seconds, normally sampled at start + 0.1, + 1.1 and + 2.1 seconds. The controller checks the current window and scans up to three further windows sequentially. Sampling and backend validation must be changed together if you tune this. The 100 ms guard holds unknown/review/blocked content and checks the next window within 0.6 seconds of the boundary. Seeking into unchecked content holds playback and prioritizes the new position. Navigation, source and settings changes invalidate relevant work; keep the generation checks so late responses cannot release a different video.

Preview modes `safe`, `review`, and `blocked` are scripted, visibly labeled, and send no frames. `previewScenario:"off"` means live mode when protection is enabled; it does not mean protection is disabled.

## Verification and evidence

```sh
uv run python -m unittest discover -s tests
node --test tests/guard.test.cjs tests/sites.test.cjs
npm ci --prefix lookahead/harness
# Stop the real backend first: this harness supplies its own relay on port 8000.
node lookahead/harness/run-unified.mjs
# Real sites (YouTube, TikTok, Snapchat by default) with the same kind of stub relay:
node lookahead/harness/run-multisite.mjs
# Restart the real backend before an optional live test (incurs API usage):
node lookahead/harness/run-unified-live.mjs XnWESGXnGwY
```

On `feat/multisite-pawse`, **14 Python tests and 8 Node tests pass**, `run-unified.mjs` passes all four checks, and `run-multisite.mjs` passed on real YouTube, TikTok (`tiktok:<id>`, MSE) and Snapchat Spotlight (plain-file decoder, CORS-readable): each sent complete 3-frame windows with the right key and resumed playback. Instagram, X, Reddit, YouTube Kids and Dailymotion were verified with the capture-only preview in a real logged-in Chrome (see `lookahead/README.md`), not yet through the full Pawse pipeline. The real-Chrome deterministic harness uses synthetic media at a non-demo YouTube ID, including a SourceBuffer codec switch. It verified frame transmission with parent settings, pause at 5.49 seconds before a flagged 6-second boundary, seeking into unchecked content, backend failure holding playback, and parent override releasing it. Its relay is mocked; this is not an accuracy benchmark.

A separate live test before the latest UI merge used the shared YouTube video and real Decisions: playback paused at 5.41 seconds before the 6–9 second window, with violence probability 0.68 and adult-review status for ages 6–8. This is one observed run, not a promised detection timestamp or repeatable score. Re-run the live harness after relevant capture/model changes.

Harness output is under ignored `artifacts/unified-browser-test/` and `artifacts/unified-live-browser/`; those local screenshots and media are not shipped. Historical experiments and measured latency are documented in [experiments/README.md](experiments/README.md) and [experiments/LATENCY.md](experiments/LATENCY.md). The old benchmark used different frame batch sizes and cache conditions; do not present it as end-to-end extension latency.

`CHROME_PATH` can select an installed Chrome executable. On the development Mac, x64 Node launching a universal Chrome binary timed out; a native arm64 launcher plus the harness’s debugging pipe worked. The temporary launcher path used locally is not part of the repository. If npm’s default cache has permissions problems, use a writable cache with `npm ci --prefix lookahead/harness --cache /tmp/pawse-npm-cache`.

## Known gaps and next integration work

- Supported sites are listed in `sites.js` and `manifest.json`; add a site by writing an adapter, adding explicit matches, and testing capture first—not by adding broad host permissions. Facebook and Twitch need worker-MediaSource capture. Instagram, X, Reddit, YouTube Kids and Dailymotion still need a full-pipeline run with the real backend.
- Feeds: on page-key feeds, decisions are per video source but the key is per page; Dailymotion only buffers ~3 s ahead, so checks there often hold playback briefly.
- Visual samples can miss brief events; there is no audio/transcript classification, recommendation filtering, persistent verdict cache, or video-wide safety guarantee.
- Ads, worker-based MediaSource, DRM, live streams and unavailable buffers can leave playback held. Long videos and codec/quality changes need more testing. The decoder currently replays captured chunks per window, which can get expensive.
- The MAIN-world message bridge trusts the page environment. It is not hardened against a hostile page forging frame responses. The playback guard is best effort, not a security boundary; background throttling and high playback speeds need additional validation.
- Parent controls and approvals need a 4–8 digit PIN (from `feat/youtube-protection-extension`), but children can still disable or remove an unmanaged extension in `chrome://extensions`. “Allow once” deliberately bypasses checks for the video’s browser session.
- The unauthenticated relay is for loopback development only. Its Origin checks are not authentication. Hosted deployment requires authentication and a deliberate extension/backend configuration change. Keep API keys server-side and out of commits, logs, screenshots and handoffs.

For new UI changes, preserve the live-versus-preview distinction and report window-level results without claiming an entire video is safe. For model changes, preserve strict parsing and the parent policy. For capture changes, run the codec-switch/seek tests and a live YouTube check. After updating installed code, reload the extension **and** the YouTube tab; restart the backend after Python changes.
