// Drives a real Chrome (Chrome for Testing) with the unpacked extension loaded,
// opens a real YouTube watch page, pauses the player early, and asks the extension
// to decode frames from buffered-but-unplayed media. Writes evidence to ./out/<run>.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VIDEO = process.argv[2] || 'aqz-KE-bpKQ'; // Big Buck Bunny (Blender Foundation, public)
const HEADLESS = process.env.HEADFUL ? false : true;
const here = path.dirname(new URL(import.meta.url).pathname);
const ext = path.resolve(here, '../extension');
const chrome = fs.readdirSync(path.join(here, 'chrome')).map(d => path.join(here, 'chrome', d,
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync);
const out = path.join(here, 'out', `${VIDEO}-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: chrome, headless: HEADLESS, enableExtensions: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', '--lang=en-US'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const timeline = [];
try {
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Consent wall (EU) if present.
  for (const sel of ['button[aria-label*="Accept all"]', 'form[action*="consent"] button']) {
    const b = await page.$(sel); if (b) { await b.click().catch(() => {}); log('clicked consent'); await sleep(3000); break; }
  }
  const hookPresent = await page.evaluate(() => !!window.__lookahead);
  log('extension hook present in MAIN world:', hookPresent);
  if (!hookPresent) throw new Error('content script did not inject');

  // Wait for main content (not an ad) to start, then pause as early as possible.
  let pausedAt = null;
  for (let i = 0; i < 240 && pausedAt === null; i++) {
    const s = await page.evaluate(() => {
      const p = document.querySelector('#movie_player');
      const st = window.__lookahead.playerState();
      return { ...st, ad: !!p?.classList.contains('ad-showing') };
    });
    if (i % 4 === 0) log('waiting', JSON.stringify({ t: s.currentTime, ad: s.ad, paused: s.paused, buf: s.buffered }));
    if (s.hasVideo && !s.ad && s.currentTime > 0.5) {
      pausedAt = await page.evaluate(() => { const v = [...document.querySelectorAll('video')].find(v => v.src?.startsWith('blob:')); v.pause(); return v.currentTime; });
    }
    await sleep(250);
  }
  if (pausedAt === null) throw new Error('main video never started');
  log('paused original player at', pausedAt.toFixed(3));

  // Watch: position must not move; buffer may keep growing.
  for (let i = 0; i < 20; i++) {
    const st = await page.evaluate(() => window.__lookahead.playerState());
    timeline.push({ wall: Date.now(), currentTime: st.currentTime, paused: st.paused, bufferedUntil: st.bufferedUntil, buffered: st.buffered });
    if (i % 4 === 0) log('paused-watch', st.currentTime.toFixed(3), 'buffered until', st.bufferedUntil.toFixed(2));
    await sleep(1000);
  }
  const before = await page.evaluate(() => window.__lookahead.summary());
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(before, null, 2));
  log('sourceBuffers', JSON.stringify(before.sourceBuffers.map(s => ({ id: s.id, mime: s.mime, appends: s.appends, bytes: s.bytesHeld, covered: s.coveredByCapture }))));
  log('diag', JSON.stringify(before.diag));

  const cur = before.player.currentTime, until = before.player.bufferedUntil;
  const times = [];
  for (let t = Math.ceil(cur) + 3; t < until - 0.5; t += Math.max(2, (until - cur) / 8)) times.push(+t.toFixed(2));
  log('decoding future timestamps', times.join(', '));
  const dec = await page.evaluate(t => window.__lookahead.decodeFuture({ times: t }), times);
  const after = await page.evaluate(() => window.__lookahead.playerState());

  const frames = [];
  for (const f of dec.frames) {
    if (!f.jpeg) { frames.push(f); continue; }
    const file = `future_${f.requested.toFixed(2)}s.jpg`;
    fs.writeFileSync(path.join(out, file), Buffer.from(f.jpeg.split(',')[1], 'base64'));
    frames.push({ timestamp: f.requested, decodedAt: f.decodedAt, size: `${f.width}x${f.height}`, meanLuma: +f.meanLuma.toFixed(1), file });
  }

  // Offline cross-check: dump raw captured video bytes and let ffmpeg decode them.
  const sbId = await page.evaluate(() => window.__lookahead.activeVideoRecord());
  const chunks = await page.evaluate(id => window.__lookahead.exportChunks(id), sbId);
  const ext2 = dec.mime.includes('webm') ? 'webm' : 'mp4';
  const firstInit = chunks.findIndex(c => c.init);
  const raw = Buffer.concat(chunks.slice(firstInit).map(c => Buffer.from(c.b64, 'base64')));
  const rawFile = path.join(out, `captured_video.${ext2}`);
  fs.writeFileSync(rawFile, raw);
  fs.writeFileSync(path.join(out, 'chunks.json'), JSON.stringify(chunks.map(({ b64, ...c }) => ({ ...c, bytes: Buffer.from(b64, 'base64').length })), null, 1));
  let ffprobe = null;
  try { ffprobe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=format_name,duration', '-of', 'json', rawFile]).toString(); } catch (e) { ffprobe = String(e.stderr || e); }

  // Validation AFTER evidence capture: let the original player reach those timestamps
  // and compare what it actually displays with what we decoded in advance.
  const compare = await page.evaluate(async (ts) => {
    const v = [...document.querySelectorAll('video')].find(v => v.src?.startsWith('blob:'));
    const c = document.createElement('canvas'); c.width = 160; c.height = 90; const x = c.getContext('2d');
    const res = [];
    for (const t of ts) { v.currentTime = t; await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      x.drawImage(v, 0, 0, 160, 90); res.push({ t, jpeg: c.toDataURL('image/jpeg', 0.9) }); }
    return res;
  }, frames.filter(f => f.file).map(f => f.decodedAt));
  const decodedSmall = await page.evaluate(async (list) => Promise.all(list.map(async (u) => {
    const img = new Image(); img.src = u; await img.decode();
    const c = document.createElement('canvas'); c.width = 160; c.height = 90; const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 160, 90); return Array.from(x.getImageData(0, 0, 160, 90).data);
  })), dec.frames.filter(f => f.jpeg).map(f => f.jpeg));
  const playerSmall = await page.evaluate(async (list) => Promise.all(list.map(async (u) => {
    const img = new Image(); img.src = u; await img.decode();
    const c = document.createElement('canvas'); c.width = 160; c.height = 90; const x = c.getContext('2d');
    x.drawImage(img, 0, 0); return Array.from(x.getImageData(0, 0, 160, 90).data);
  })), compare.map(c => c.jpeg));
  const mad = (a, b) => { let s = 0, n = 0; for (let i = 0; i < a.length; i += 4) { s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; } return s / n; };
  const validation = compare.map((c, i) => {
    const file = `player_at_${c.t.toFixed(2)}s.jpg`;
    fs.writeFileSync(path.join(out, file), Buffer.from(c.jpeg.split(',')[1], 'base64'));
    // also compare against a different decoded frame as a baseline
    const other = decodedSmall[(i + 1) % decodedSmall.length];
    return { t: c.t, playerFile: file, meanAbsDiffSameTime: +mad(decodedSmall[i], playerSmall[i]).toFixed(2),
      meanAbsDiffOtherFrame: +mad(other, playerSmall[i]).toFixed(2) };
  });

  const vrec = before.sourceBuffers.find(s => s.id === sbId);
  const result = {
    platform: 'youtube', videoId: VIDEO, chrome: await browser.version(), headless: HEADLESS,
    observed: {
      mseHooksFired: before.sourceBuffers.length > 0,
      sourceBuffers: before.sourceBuffers.map(s => ({ mime: s.mime, appends: s.appends, bytes: s.bytesHeld })),
      workerMse: before.diag,
      videoMime: dec.mime, encodedVideoBytesCaptured: vrec?.bytesHeld,
    },
    playback_position_when_paused: pausedAt,
    playback_position_before_decode: cur, playback_position_after_decode: after.currentTime,
    player_paused_throughout: timeline.every(s => s.paused) && after.paused,
    max_position_drift_while_paused: Math.max(...timeline.map(s => Math.abs(s.currentTime - pausedAt))),
    buffered_until: until, future_seconds_available: +(until - cur).toFixed(2),
    decoder: { replayedChunks: dec.replayedChunks, replayedBytes: dec.replayedBytes, decoderBuffered: dec.decoderBuffered, errors: dec.errors },
    future_frames_decoded: frames,
    original_player_advanced: Math.abs(after.currentTime - cur) > 0.01,
    ffprobe_on_raw_capture: (() => { try { return JSON.parse(ffprobe); } catch { return ffprobe; } })(),
    post_hoc_validation_vs_player: validation,
    paused_timeline: timeline,
  };
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  log('RESULT', JSON.stringify({ ...result, paused_timeline: undefined, observed: result.observed }, null, 1));
  log('out dir:', out);
} catch (e) {
  log('FAILED', e.stack || e);
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
