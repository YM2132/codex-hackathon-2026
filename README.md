# Pawse: look-ahead video protection for kids

Pawse is a Chrome extension that checks the next few seconds of a video **before your child sees them**. It decodes frames the site has already buffered, asks OpenAI Decisions whether they fit your family's rules, and pauses playback before anything flagged. Pawse the dog explains what's happening in kid-friendly language.

**Supported:** YouTube, YouTube Kids, TikTok, Instagram, X, Reddit, Snapchat, Dailymotion.
**Not supported** (videos aren't checked): Facebook, Twitch, Vimeo, Netflix and other DRM services.

## Install

You need Google Chrome, [uv](https://docs.astral.sh/uv/getting-started/installation/) (`brew install uv` on macOS) and an OpenAI API key with Decisions access.

```sh
git clone https://github.com/YM2132/codex-hackathon-2026.git
cd codex-hackathon-2026
./start.sh
```

`start.sh` asks for your API key once and saves it to `.env`, which is git-ignored and never put in the extension. It then installs dependencies and starts the local backend. Keep the terminal open while using Pawse.

Then, in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `codex-hackathon-2026` folder.
3. Pin Pawse, open it and choose your child's age. **The default parent PIN is `1111`. Change it straight away** under *Parent PIN*.
4. Reload any video tab that was already open, then play a video.

On Windows, or to run the backend by hand: put `OPENAI_API_KEY=...` in `.env` (see `.env.example`), then run `uv sync` and `uv run uvicorn backend.app:app --host 127.0.0.1 --port 8000`.

## Using Pawse

- **While a video plays:** Pawse checks it in 3-second windows ahead of playback. Checked windows play. Pawse pauses the video before a flagged window and shows the dog with options to ask a grown-up or go back.
- **Parent popup** (PIN-protected; unlock lasts 10 minutes): age band (3–5, 6–8 or 9–12), on/off, plain-language family rules (e.g. "No scary monsters"), and **inspect this video**, which unlocks the current video for a grown-up to watch and judge (this browser session only). The extension's background worker enforces the PIN, so a child can't switch protection off, change settings or unlock a video without it.
- **Feeds** (TikTok, Instagram, X, Reddit): only the video being watched plays, and each new video is checked.
- **Built-in categories:** violence, sexual content, frightening content, dangerous behaviour, substance use, hate, visible profanity. Political and religious content is only blocked if a family rule says so.
- **Preview states** in the popup demo the UI without sending any frames.

## Keeping it on

Inside Chrome, Pawse can't be switched off without the PIN, and if the backend stops, videos stay paused. A child with access to Chrome's settings can still get around it, though:

- **Removing or disabling the extension** in `chrome://extensions`, or opening an **Incognito** window, where extensions don't run by default.
- **Using another browser**, or a video site Pawse doesn't support.

To close these gaps, give your child a supervised setup you control:
- a **separate macOS user** with *Screen Time* limiting apps to Chrome;
- **Chrome policies** such as `IncognitoModeAvailability=1`, `DeveloperToolsAvailability=2`, and a `URLBlocklist` containing `chrome://extensions`.

On an unmanaged Mac, policies may need a configuration profile; check `chrome://policy` after restarting Chrome.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Pawse cannot reach the Decisions service" | The backend isn't running: run `./start.sh`. If it is running, check that your key has Decisions access. |
| No Pawse on a supported site | Reload the tab after installing or updating the extension. |
| Video keeps pausing every few seconds | Pawse is waiting for the next check. Dailymotion only buffers about 3 s ahead, so this happens more there. |
| Video stays paused with "buffer unavailable" | That player can't be checked (worker-based or DRM). |

Also disable the older "Video Look-ahead Preview" extension if you loaded it: both hook the same browser APIs.

## Limits

This is a hackathon prototype:
- Pawse samples about one frame per second, so it can miss brief events.
- Audio isn't analysed, and model results can be wrong.
- It's best-effort protection, not a security boundary: an unmanaged extension can be disabled in `chrome://extensions`.
- The backend is an unauthenticated local relay. Keep it on `127.0.0.1`.

## How it works

`page-hook.js` copies the encoded video the site appends to Media Source Extensions and decodes future frames in a hidden player. `engine.js` sends 3 frames per window through `service-worker.js` to `backend/app.py`, which calls `POST /v1/decisions` and applies the age thresholds. `guard.js` and `content.js` pause or resume playback and show Pawse. Each site's URL and player handling lives in `sites.js`.

## Development

```sh
uv run python -m unittest discover -s tests
node --test tests/guard.test.cjs tests/sites.test.cjs
npm ci --prefix lookahead/harness
node lookahead/harness/run-unified.mjs      # synthetic video + stub backend (stop the real one first)
node lookahead/harness/run-multisite.mjs    # real YouTube/TikTok/Snapchat + stub backend
node lookahead/harness/stub-relay.mjs       # keyless stub backend for manual testing
```

Contributors and agents: read [AGENT_HANDOFF.md](AGENT_HANDOFF.md) for contracts, branch history and known gaps. Capture research and per-site results are in [lookahead/README.md](lookahead/README.md), and model experiments in [experiments/README.md](experiments/README.md).
