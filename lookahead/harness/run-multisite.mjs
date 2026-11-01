// Real-site smoke test for the unified Pawse extension: real pages, real capture, stub relay.
// No OpenAI calls: a local relay on :8000 answers every window as "safe" and records what it got.
// Stop the real backend first. Usage: node lookahead/harness/run-multisite.mjs [url ...]
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'artifacts/multisite-browser-test');
fs.mkdirSync(out, {recursive: true});
const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  'https://www.tiktok.com/@nasa/video/7675478347278863629',
  'https://www.snapchat.com/spotlight',
];
const calls = [];
const relay = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const scan = JSON.parse(raw); calls.push({videoId: scan.videoId, start: scan.start, end: scan.end, frames: scan.frames.length});
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({videoId: scan.videoId, start: scan.start, end: scan.end, status: 'safe', category: null,
    probability: .01, provenance: 'live', preview: false, frameCount: scan.frames.length, apiSeconds: .05}));
});
await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(8000, '127.0.0.1', resolve); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || undefined, headless: !process.env.HEADFUL, pipe: true,
  enableExtensions: [root], args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  defaultViewport: {width: 1280, height: 860},
});
const results = [];
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker', {timeout: 15000});
  const worker = await target.worker();
  await sleep(500);
  await worker.evaluate(() => chrome.storage.sync.set({setupComplete: true, protectionOn: true, ageBand: '6-8', customRules: [], previewScenario: 'off'}));
  for (const url of urls) {
    const page = await browser.newPage();
    const before = calls.length;
    const row = {url};
    try {
      await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 45000});
      // Pawse holds playback until the first window is checked, then resumes it; nudge play once.
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        await page.evaluate(() => { for (const v of document.querySelectorAll('video')) if (v.paused && v.currentTime === 0) { v.muted = true; v.play().catch(() => {}); } }).catch(() => {});
        if (calls.length - before >= 3) break;
      }
      await sleep(3000);
      const mine = calls.slice(before);
      row.state = await page.evaluate(() => {
        const v = window.__lookahead?._internal.pickVideo();
        const badge = document.querySelector('#pawse-protection-root')?.shadowRoot?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120);
        return {t: v?.currentTime, paused: v?.paused, kind: v && window.__lookahead._internal.classify(v).kind, overlay: badge || null};
      });
      row.keys = [...new Set(mine.map(c => c.videoId))];
      row.windows = mine.map(c => `${c.start}-${c.end}s/${c.frames}f`);
      row.ok = mine.length > 0 && mine.every(c => c.frames >= 1) && row.state.t > 0;
      await page.screenshot({path: path.join(out, `${new URL(url).hostname}.png`)});
    } catch (e) { row.error = String(e.message || e); }
    results.push(row);
    console.log(row.ok ? 'PASS' : 'FAIL', url, JSON.stringify({keys: row.keys, windows: row.windows?.slice(0, 6), state: row.state, error: row.error}));
    await page.close();
  }
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({results, calls}, null, 2));
  await browser.close(); relay.close();
}
