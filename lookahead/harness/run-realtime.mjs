// Lets YouTube play normally and repeatedly decodes frames 5/10/15s ahead of the playhead.
import puppeteer from 'puppeteer';
import fs from 'node:fs'; import path from 'node:path';
const VIDEO = process.argv[2] || 'aqz-KE-bpKQ', DURATION = +(process.argv[3] || 60);
const here = path.dirname(new URL(import.meta.url).pathname), ext = path.resolve(here, '../extension');
const chrome = fs.readdirSync(path.join(here, 'chrome')).map(d => path.join(here, 'chrome', d,
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__lookahead?.playerState().currentTime > 0.5 && !document.querySelector('#movie_player')?.classList.contains('ad-showing'), { timeout: 60000 });
const rows = [], t0 = Date.now();
while (Date.now() - t0 < DURATION * 1000) {
  const r = await page.evaluate(async () => {
    const mv=[...document.querySelectorAll('video')].find(v=>v.src?.startsWith('blob:')); if (mv.paused) { mv.muted = true; await mv.play().catch(()=>{}); }
    const s = window.__lookahead.playerState(), w0 = performance.now();
    const times = [5, 10, 15].map(d => +(s.currentTime + d).toFixed(2));
    let d; try { d = await window.__lookahead.decodeFuture({ times }); } catch (e) { return { err: String(e) }; }
    const s2 = window.__lookahead.playerState();
    return { playhead: s.currentTime, ahead: s.aheadSeconds, ms: performance.now() - w0, playing: !s2.paused,
      replayedMB: d.replayedBytes / 1e6, ok: d.frames.map(f => f.jpeg ? 'ok' : 'miss'), playheadAfter: s2.currentTime };
  });
  rows.push(r);
  console.log(JSON.stringify({ playhead: r.playhead?.toFixed(1), aheadBuffered: r.ahead?.toFixed(1), decodeMs: Math.round(r.ms), replayedMB: r.replayedMB?.toFixed(2), frames: r.ok?.join('/'), playing: r.playing, err: r.err }));
  await new Promise(x => setTimeout(x, 2000));
}
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out', `realtime-${VIDEO}-${Date.now()}.json`), JSON.stringify(rows, null, 1));
await browser.close();
