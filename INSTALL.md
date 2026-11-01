# Install Pawse for the hackathon

Pawse is a prototype Chrome extension with a small local backend. Allow a few minutes for the first setup. You need **desktop Google Chrome**, **Python 3.11 or newer**, internet access, and an **OpenAI API key with Decisions access** for live checks. You do not need Git, uv, Node, npm or ffmpeg to use the packaged application.

## 1. Download and unzip

Use **`pawse-hackathon.zip`** from the release supplied by the team. Extract it fully to a permanent folder, such as Documents/Pawse. Do not run the app from inside the ZIP, and keep the extracted folder after installation.

The full kit contains:

```text
Pawse/
  extension/             ← select this folder in Chrome
  Start Pawse.command    ← macOS launcher
  Start Pawse.bat        ← Windows launcher
  start.sh               ← Linux/macOS terminal launcher
  start.py
  INSTALL.md
  backend/ ...
```

`pawse-extension.zip` is only for someone who already has the local backend running; it cannot perform live checks by itself. If using GitHub’s **Code → Download ZIP** instead of a packaged release, the extension is the repository folder containing the root `manifest.json`, not `lookahead/extension`.

## 2. Start the backend

Install [Python 3.11 or newer](https://www.python.org/downloads/) if needed. On Windows, enable the installer’s **Add Python to PATH** option.

- **macOS:** open `Start Pawse.command`. If macOS does not launch the downloaded script, open Terminal, type `bash `, drag `start.sh` into the terminal, and press Return.
- **Windows:** open `Start Pawse.bat` after extracting the ZIP.
- **Linux:** open a terminal in the extracted Pawse folder and run `bash start.sh`. Your Python installation needs its `venv` module.
- **Any OS:** from that folder, run `python3 start.py` (Windows: `py -3 start.py`).

The launcher creates a private Python environment and installs the backend packages on first use. It then asks for your API key; typing is hidden. The key is saved in `.env` on your computer and is never included in the extension. If you already set `OPENAI_API_KEY` in your environment or `.env`, it is reused. Do not send your populated `.env` to other people.

**Leave the backend terminal open.** A successful start prints `Uvicorn running on http://127.0.0.1:8000`. Ctrl+C stops it. Subsequent launches reuse the installed packages.

## 3. Load the extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** at the top right.
3. Click **Load unpacked** and select **Pawse/extension** from the extracted full kit.
4. Pin **Pawse** using Chrome’s puzzle-piece Extensions menu.
5. Open Pawse, choose an age profile, set a **4–8 digit parent PIN**, and enable protection.
6. Confirm the popup says **Backend connected**. The connection check confirms backend/key configuration, not the key’s API permissions; the first live classification verifies those.
7. Keep **Ready / No sample state** selected for real checks. Other state buttons are labeled previews and do not call the model.

Disable an older Pawse or Video Look-ahead Preview installation before enabling this copy, so two extensions do not control the same player. Refresh any video tab that was open before installation.

## 4. Try the demo

Open [the shared hackathon video](https://www.youtube.com/watch?v=XnWESGXnGwY). Dismiss YouTube’s cookie notice if shown, then press Play. Pawse briefly holds playback while checking upcoming visual samples; a flagged window pauses playback and shows the dog. Use the popup and parent PIN to approve once or adjust rules.

The build also includes adapters for YouTube Kids, TikTok, Instagram, X, Reddit, Snapchat and Dailymotion. Some sites require sign-in or buffer differently; use the shared YouTube clip for the first judge walkthrough. YouTube Shorts, Facebook, Twitch, Vimeo and DRM services are outside the supported demo paths. No extension inspection is performed on other websites.

For a UI-only walkthrough without a key/backend, load the extension, complete setup, and choose a labeled preview state. **This demonstrates the interface, not real content detection.**

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Python not found / unsupported version | Install Python 3.11+ and reopen the terminal or launcher. |
| Package installation failed | Check internet access and retry the launcher. On Linux, install the Python venv package if requested. |
| Port 8000 is occupied | Stop an older backend with Ctrl+C in its terminal. Do not close unrelated apps blindly. |
| Backend unavailable in the popup | Start Pawse and leave the terminal open; click **Check connection**. |
| Backend connected, but classification fails | Confirm the API key has Decisions access and quota; the backend intentionally holds playback on errors. |
| Cannot find manifest / Chrome rejects the folder | Extract the ZIP first and select the folder containing `manifest.json`: `Pawse/extension` in the full kit. |
| No Pawse after installing/updating | Reload the extension in `chrome://extensions`, then refresh the video tab. |
| Lost parent PIN | For this hackathon, remove and reload the extension to reset its local state; this discards its settings. |
| Video keeps waiting / buffer unavailable | That player may be unsupported or not buffering ahead. Try the shared YouTube clip and check the backend terminal. |

This is visual sampling, not a safety guarantee: brief events and audio can be missed, and model results can be wrong. Parent PIN controls do not stop someone disabling an unmanaged extension. Keep the unauthenticated backend on `127.0.0.1`; this kit is not a public hosted service.

## Team: produce the judge download

```sh
python3 scripts/build_package.py
```

Distribute `dist/pawse-hackathon.zip` and this guide. The builder uses an allowlist and excludes credentials, tests, source videos, development environments and the alternate extension. `dist/pawse-extension.zip` and `dist/SHA256SUMS.txt` are also generated.

The **Judge package** GitHub Actions workflow runs tests and builds downloadable artifacts on pull requests and pushes to main. Artifacts may require GitHub sign-in; for judges, attach the two ZIPs and checksum file to a public GitHub Release after the PR is merged. Publishing a release triggers the workflow to attach packages built from that release’s tag. Do not link judges to a release until the assets are present.
