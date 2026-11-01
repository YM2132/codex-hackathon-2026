# YouTube look-ahead capture (PoC)

Copies the encoded media YouTube hands to MSE (`SourceBuffer.appendBuffer`) and decodes
*future* frames in a separate hidden `<video>`, without moving YouTube's own player.

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

## Limitations
- Only sees MSE on the main thread. Worker MSE (`MediaSourceHandle`) is detected and reported, not captured.
- Encrypted (EME/DRM) media can be copied but not decoded.
- Look-ahead is limited by YouTube's own readahead (~20s observed while paused).
- Video only; audio buffers are captured but not analysed yet.
