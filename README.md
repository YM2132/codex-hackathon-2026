# Sprout — look-ahead YouTube protection

**Today’s build checks only https://www.youtube.com/watch?v=XnWESGXnGwY. Other videos are unaffected.**

One Chrome extension combining the Sprout mascot and parent controls, buffered video capture, and the live OpenAI Decisions classifier. Integration branch: `feat/unified-sprout-extension`.

## Run the unified extension

```sh
git switch feat/unified-sprout-extension
uv sync
# Set OPENAI_API_KEY in .env (backend only).
uv run uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the **repository root**. Disable the separate look-ahead preview extension if installed.
2. Pin Sprout. Open its popup, choose the child's age, and click **Set up protection**.
3. Keep **Preview the experience → No sample state** selected for real model calls.
4. Reload the YouTube tab once after installing. The capture hook must run before YouTube creates its video buffer.
5. Open the [shared test video](https://youtu.be/XnWESGXnGwY), then press Play if the browser requires it. Sprout holds playback while it checks, lets checked windows play, and pauses before a flagged window. Open the popup for status, a parent override, or family rules.

The backend must remain running. `http://127.0.0.1:8000/health` reports whether it has a key configured. No key is stored in the extension. Frame samples and parent rules are sent to OpenAI through the local backend. This path uses the bytes already buffered by YouTube; it does not invoke yt-dlp.

## How the pieces connect

- **Sprout UI** (`content.js`, `popup.*`, `assets/`): parent profiles, plain-language rules, pause card, mascot, help requests, and a session override.
- **Look-ahead capture** (`lookahead/extension/page-hook.js`): copies the player's MediaSource chunks and decodes future frames in a separate hidden video element. The original player's position is not changed for capture.
- **Controller** (`engine.js`, `guard.js`): requests three samples per three-second window at roughly one-second intervals, scans up to four windows including the current one, and guards playback. Short final windows use fewer samples. All frames in a window are assessed together in one Decisions request.
- **Service worker** (`service-worker.js`): forwards frames and the latest parent profile to the local relay; stores recent status for the popup.
- **Backend** (`backend/app.py`): calls `POST /v1/decisions` with `gpt-6-luna`, reuses the experiment's nine categories, adds one predicate per family rule, validates all answers, and returns window scores plus request latency.

Politics and religion are descriptive tags and do not block by default; a family rule can opt into avoiding them. The demo blocking thresholds are 0.50 for ages 3–5, 0.70 for 6–8, and 0.85 for 9–12. Scores in the 0.20-wide band below the blocking threshold trigger adult review (minimum 0.30). These are prototype choices, not calibrated child-safety guarantees.

Missing frames, missing/refused answers, an unavailable backend, or an unsupported capture path keep the video paused. Seeking into unchecked content holds it for a new check. Changing settings invalidates checked windows and session overrides. A short boundary margin stops playback before the next unchecked/flagged window. Parent approval explicitly bypasses checks for that video for the browser session.

## Current limits

This is a hackathon prototype: visual sampling can miss brief events, audio is not analyzed, and model results can be wrong. The browser guard is best effort and is not a managed-device security boundary. The popup is not PIN protected. Ads are held for adult review. Worker-based MediaSource, DRM, live streams, and player paths without captured buffers are unsupported and remain held. Standard YouTube watch pages are the demo target; Shorts and recommendation filtering are not validated here.

The MAIN-world capture bridge trusts the YouTube page's media environment; it is not hardened against a malicious page forging bridge messages. The backend binds only to loopback. Do not expose this unauthenticated development relay publicly.

**Preview mode** remains available for UI demos and is clearly labeled. It sends no frames and is not a model prediction. The original capture-only preview and harnesses remain under `lookahead/`; load only the root extension for the unified flow.

## Tests

```sh
uv run python -m unittest discover -s tests
node --test tests/guard.test.cjs
npm ci --prefix lookahead/harness
node lookahead/harness/run-unified.mjs
```

The browser integration test uses a generated MSE video and a deterministic local HTTP relay (no OpenAI calls). Stop the real backend first because the test binds port 8000. It checks capture, transmitted settings, pause before a flagged boundary, backend failure, and parent override. Set `CHROME_PATH` to a Chrome for Testing executable if Puppeteer's bundled browser is unavailable. Test artifacts are written under ignored `artifacts/`.

## Shared test video

Use [this YouTube test video](https://youtu.be/XnWESGXnGwY) for the team's extension and content-classification experiments. Video ID: `XnWESGXnGwY`.

See [experiment setup and run instructions](experiments/README.md) for the frame-sampling and Decisions API pipeline on this branch.

See the [latency benchmark](experiments/LATENCY.md) for measured response times across 1, 3, 5, 10, and 13 frames per Decisions request (five calls per size, with cache usage recorded).

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
