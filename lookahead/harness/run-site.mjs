// Generic smoke test: open any URL with the extension, start the main video, and report what the
// look-ahead panel shows in each frame. Usage: node run-site.mjs <url> [<url> ...]   (HEADFUL=1 to watch)
import puppeteer from 'puppeteer'; import fs from 'node:fs'; import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname), ext = path.resolve(here, '../extension');
const chrome = fs.readdirSync(path.join(here, 'chrome')).map(d => path.join(here, 'chrome', d,
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(fs.existsSync);
const out = path.join(here, 'out', `sites-${Date.now()}`); fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: chrome, headless: !process.env.HEADFUL, enableExtensions: true,
  defaultViewport: { width: 1400, height: 850 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--lang=en-US'] });

const statusAll = (p) => Promise.all(p.frames().map(f => f.evaluate(() => {
  const v = window.__lookahead?._internal.pickVideo();
  return window.__lookaheadStatus ? { url: location.host + location.pathname.slice(0, 40), ...window.__lookaheadStatus(),
    t: v?.currentTime, paused: v?.paused, kind: v ? window.__lookahead._internal.classify(v).kind : null,
    sbs: window.__lookahead.summary().sourceBuffers.map(s => `${s.mime} x${s.appends}`), diag: window.__lookahead.summary().diag } : null;
}).catch(() => null))).then(r => r.filter(Boolean));

const results = [];
// An argument may be "listingURL -> hrefRegex": open the listing, then follow the first matching link.
for (const arg of process.argv.slice(2)) {
  const [url, linkRe] = arg.split(' -> ');
  const p = await b.newPage();
  const row = { url: arg };
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2500);
    if (linkRe) {
      await sleep(3000);
      const href = await p.evaluate(re => [...document.querySelectorAll('a[href]')].map(a => a.href).find(h => new RegExp(re).test(h)), linkRe);
      if (!href) throw new Error('no link matching ' + linkRe);
      row.resolved = href;
      await p.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2500);
    }
    // Dismiss common consent dialogs.
    for (const f of p.frames()) await f.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(b => /^(accept all|accept|i agree|agree|allow all|reject all)$/i.test(b.textContent.trim()));
      b?.click();
    }).catch(() => {});
    // Start playback: try play() in every frame, then click the biggest video if still idle.
    for (let i = 0; i < 20; i++) {
      for (const f of p.frames()) await f.evaluate(() => {
        for (const v of document.querySelectorAll('video')) if (!v.__lookaheadDecoder && v.paused && v.currentTime < 1) { v.muted = true; v.play().catch(() => {}); }
      }).catch(() => {});
      const st = await statusAll(p);
      if (st.some(s => s.t > 1)) break;
      if (i === 2) { const v = await p.$('video'); if (v) await v.click().catch(() => {}); }
      await sleep(1000);
    }
    await sleep(6000);                                // let the player buffer ahead and the panel update
    const st = await statusAll(p);
    row.frames = st;
    row.ok = st.some(s => s.shown && /^Frame @/.test(s.label));
    await p.screenshot({ path: path.join(out, `${new URL(url).hostname}-${results.length}.png`) });
  } catch (e) { row.error = String(e.message || e); }
  results.push(row);
  console.log(row.ok ? 'PASS' : 'FAIL', url, row.resolved || '');
  for (const s of row.frames || []) console.log('   ', JSON.stringify({ frame: s.url, kind: s.kind, shown: s.shown, t: s.t?.toFixed?.(1), label: s.label, stats: s.stats, sbs: s.sbs, worker: s.diag.mediaSourceHandleAttached }));
  if (row.error) console.log('   error:', row.error);
  await p.close();
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log('out', out);
await b.close();
