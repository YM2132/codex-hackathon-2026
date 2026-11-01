# Video look-ahead capture (PoC)

Copies the encoded media YouTube hands to MSE (`SourceBuffer.appendBuffer`) and decodes
*future* frames in a separate hidden `<video>`, without moving YouTube's own player.

## Supported sites
The extension only runs on these sites (everything else is treated as unsupported):

- YouTube (`www.youtube.com`, including embeds)
- YouTube Kids (`www.youtubekids.com`)
- TikTok (`www.tiktok.com`)
- Instagram (`www.instagram.com`)
- X (`x.com`)
- Reddit (`www.reddit.com`)
- Snapchat (`www.snapchat.com`)
- Dailymotion (`www.dailymotion.com`, player on `geo.dailymotion.com`)
- Test players: hls.js demo (`hlsjs.video-dev.org`), dash.js reference (`reference.dashif.org`)

Test results and unsupported sites are in the **Site support** section below.

## Demo: live look-ahead preview
1. `chrome://extensions` → Developer mode → **Load unpacked** → select `lookahead/extension/`.
2. Open (or reload) any YouTube watch page and press play.
3. A "Look-ahead preview" panel (top right) shows the frame **+5s ahead** of the playhead, updated ~2×/s.
   Switch +3s / +5s / +10s. The red marker on the bar is the previewed frame, white is the playhead.
   Wait a few seconds and the main player reaches the frame you already saw in the panel.

Not shown in fullscreen (panel lives on the page). Reload the tab after (re)loading the extension:
the hook must run before YouTube creates its MediaSource.

## Console API
In DevTools console (top frame): `await __lookahead.summary()` then
   `await __lookahead.decodeFuture({ times: [10, 15] })` → frames as JPEG data URLs.

## Automated evidence run
```
cd harness && npm i && npx @puppeteer/browsers install chrome@156.0.8078.80
node run-youtube.mjs [videoId]      # HEADFUL=1 to watch it
```
Writes `out/<video>-<ts>/results.json`, the decoded `future_*.jpg`, `player_at_*.jpg` (post-hoc check),
and `captured_video.mp4` (raw captured bytes, independently decodable with ffmpeg).

## Site support (tested 2026-11-01, Chrome 156: automated via `harness/run-site.mjs` or in real Chrome)
The extension **only injects on the sites marked Enabled** (`manifest.json` → `content_scripts.matches`).
Everywhere else it does nothing; the toolbar popup says the site is unsupported and its videos are not scanned.

| Site / player | Result | Enabled |
|---|---|---|
| YouTube | Works: +5s frame, ~25-30 ms per frame | yes |
| YouTube Kids | Works (real Chrome): +5s, ~29s buffered ahead, 24 ms | yes |
| TikTok | Works: +5s (~8s buffered ahead), ~45-60 ms | yes |
| Instagram Reels | Works (real Chrome, logged in): +5s, ~17s buffered ahead, VP9 | yes |
| X | Works (manual test in real Chrome) | yes |
| Reddit | Works (manual test in real Chrome; finds videos inside shadow DOM) | yes |
| Snapchat Spotlight | Works via plain-file path; short clips cap the preview at clip end | yes |
| Dailymotion | Works inside geo.dailymotion.com player, but only ~2.7s buffered ahead (shows "max buffered") | yes |
| hls.js demo / dash.js reference | Work; preview limited by each player's buffer | yes (test players) |
| Facebook | Fails: MSE runs in a worker (MediaSourceHandle), detected but not captured | no |
| Twitch | Fails: MSE runs in a worker (MediaSourceHandle) | no |
| PBS Kids | Not tested: video is US-only (geo-blocked) | no |
| Vimeo | Stream flagged as encrypted (encv/enca/tenc), treated as DRM | no |
| Plain large files, Wikimedia | Second decoder stalls on large files; needs range-fetch + WebCodecs | no |
| DRM (Netflix, Disney+, Prime, paid YouTube) | Not possible: only the browser's CDM can decode | no |

To enable a site after verifying it by hand: add its pattern to `matches` and reload the extension.

## Limitations
- Look-ahead is bounded by each player's own readahead.
- Video only; audio buffers are captured but not analysed yet.
- Unsupported sites are currently just ignored. In the child-safety product they should be treated as
  "unscanned" (blocked or flagged by policy), not silently allowed.
