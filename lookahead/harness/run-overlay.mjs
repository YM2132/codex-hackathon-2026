// Smoke test for the live preview overlay on real YouTube. Saves screenshots to out/overlay-*.
import puppeteer from 'puppeteer'; import fs from 'node:fs'; import path from 'node:path';
const VIDEO = process.argv[2] || 'aqz-KE-bpKQ';
const here = path.dirname(new URL(import.meta.url).pathname), ext = path.resolve(here, '../extension');
const chrome = fs.readdirSync(path.join(here, 'chrome')).map(d => path.join(here, 'chrome', d,
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync);
const out = path.join(here, 'out', `overlay-${Date.now()}`); fs.mkdirSync(out, { recursive: true });
const b = await puppeteer.launch({ executablePath: chrome, headless: !process.env.HEADFUL, enableExtensions: true,
  defaultViewport: { width: 1400, height: 850 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const p = await b.newPage();
p.on('console', m => { if (m.text().includes('[lookahead]')) console.log('page:', m.text()); });
await p.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__lookahead?.playerState().currentTime > 0.5, { timeout: 60000 });
const label = () => p.evaluate(() => { const h = [...document.body.children].find(e => e.shadowRoot?.querySelector('canvas'));
  return h ? [...h.shadowRoot.querySelectorAll('div')].map(d => d.textContent).filter(t => /Frame|Playhead|Waiting|buffered ahead/.test(t)).slice(-2).join(' | ') : 'NO OVERLAY'; });
const seek = (t) => p.evaluate(t => { const v = window.__lookahead._internal.mainVideo(); v.pause(); v.currentTime = t; }, t);
for (const [i, t] of [[1, null], [2, 6], [3, 12]]) {
  if (t !== null) await seek(t);
  await new Promise(r => setTimeout(r, 3000));
  console.log(`shot${i}`, await label());
  await p.screenshot({ path: path.join(out, `shot${i}.png`) });
}
console.log('out', out);
await b.close();
