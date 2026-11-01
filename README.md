# Pawse: look-ahead video protection for kids

Pawse is a Chrome extension that checks the next few seconds of a video **before your child sees them**. It decodes frames the site has already buffered, asks OpenAI Decisions whether they fit your family's rules, and pauses playback before anything flagged. Pawse the dog explains what's happening in kid-friendly language.

**Supported:** YouTube, YouTube Kids, TikTok, Instagram, X, Reddit, Snapchat, Dailymotion.
**Not supported** (videos aren't checked): Facebook, Twitch, Vimeo, Netflix and other DRM services.

## Install for judging

Download and extract **`pawse-hackathon.zip`** from the team’s release. You need Chrome, Python 3.11+, and an OpenAI API key with Decisions access. Git, uv, Node, npm, and ffmpeg are not needed for the packaged app.

1. Start **Start Pawse.command** on macOS or **Start Pawse.bat** on Windows (Linux: `bash start.sh`). The first launch installs backend packages and asks for your key with hidden input. Keep the terminal open.
2. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the extracted **Pawse/extension** folder.
3. Open Pawse, choose an age profile, set a parent PIN, and enable protection. Confirm **Backend connected** and select **Ready / No sample state** for live checks.
4. Refresh the tab and try [the shared demo video](https://www.youtube.com/watch?v=XnWESGXnGwY).

**[Full install guide and troubleshooting → INSTALL.md](INSTALL.md)**

Until a release is published, use GitHub’s **Code → Download ZIP**, extract it, run the same launcher, and load the repository folder containing the root `manifest.json` into Chrome. Contributors can still clone the repo and use `uv sync` / `uv run uvicorn backend.app:app --host 127.0.0.1 --port 8000`.

The key stays in your backend’s local `.env`, never in the extension. There is no bundled/shared API key or hosted service. Preview states work without a backend but are labeled UI demonstrations, not content analysis.

## Using Pawse

- **While a video plays:** Pawse checks it in 3-second windows ahead of playback. Checked windows play. Pawse pauses the video before a flagged window and shows the dog with options to ask a grown-up or go back.
- **Parent popup** (PIN-protected): age band (3–5, 6–8 or 9–12), on/off, plain-language family rules (e.g. "No scary monsters"), and **approve once** for the current video.
- **Feeds** (TikTok, Instagram, X, Reddit): only the video being watched plays, and each new video is checked.
- **Built-in categories:** violence, sexual content, frightening content, dangerous behaviour, substance use, hate, visible profanity. Political and religious content is only blocked if a family rule says so.
- **Preview states** in the popup demo the UI without sending any frames.

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

## Package and release

Run `python3 scripts/build_package.py` to create the full judge kit, extension-only ZIP, and checksums in `dist/`. The allowlist excludes keys, media, development environments and the alternate preview extension. The **Judge package** workflow validates packages on macOS, Windows and Linux; PR/main builds provide artifacts. After merging, publish a GitHub Release from the desired tag to attach the ZIPs automatically. See [INSTALL.md](INSTALL.md) for the release handoff.
