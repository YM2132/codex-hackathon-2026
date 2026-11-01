// Deterministic integration test: real extension + MSE decoder + stub HTTP relay.
// No OpenAI calls. Requires ffmpeg and npm ci in this directory.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'artifacts/unified-browser-test');
fs.mkdirSync(out, {recursive: true});
const fixture = path.join(out, 'fixture.webm');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi',
  '-i', 'testsrc2=size=320x180:rate=10', '-t', '21', '-an', '-c:v', 'libvpx', '-g', '10', '-deadline', 'realtime', '-y', fixture]);
const calls = [];
let delay = 100, fail = false;
const relay = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const scan = JSON.parse(raw); calls.push(scan);
  await new Promise(r => setTimeout(r, delay));
  res.setHeader('Content-Type', 'application/json');
  if (fail) { res.writeHead(502); res.end('{}'); return; }
  res.end(JSON.stringify({videoId: scan.videoId, start: scan.start, end: scan.end,
    status: scan.start >= 6 ? 'blocked' : 'safe', category: scan.start >= 6 ? 'violence' : null,
    probability: scan.start >= 6 ? .95 : .01, provenance: 'live', preview: false,
    frameCount: scan.frames.length, apiSeconds: .1}));
});
await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(8000, '127.0.0.1', resolve); });
let browser, page;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: !process.env.HEADFUL, pipe: true, enableExtensions: [root],
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    defaultViewport: {width: 1200, height: 800}
  });
  const target = await browser.waitForTarget(t => t.type() === 'service_worker', {timeout: 15000});
  const worker = await target.worker();
  for (let i = 0; i < 50; i++) {
    if (await worker.evaluate(async () => Object.hasOwn(await chrome.storage.session.get('adultRequests'), 'adultRequests'))) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await worker.evaluate(() => chrome.storage.sync.set({setupComplete: true, protectionOn: true, ageBand: '6-8', customRules: ['Avoid scary monsters'], previewScenario: 'off'}));
  console.log('Test profile:', await worker.evaluate(() => chrome.storage.sync.get(null)));
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Page error:', e.message); });
  page.on('console', m => { if(m.type() === 'error') console.error('Browser:', m.text()); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().includes('/fixture.webm')) return request.respond({status: 200, contentType: 'video/webm', body: fs.readFileSync(fixture)});
    if (request.isNavigationRequest()) return request.respond({status: 200, contentType: 'text/html', body: `<!doctype html><title>Sprout integration fixture</title>
      <style>body{background:#eee;font:18px system-ui}#movie_player{position:relative;width:960px;height:540px}video{width:100%;height:100%}</style>
      <h1>Sprout integration fixture</h1><div id="movie_player"><video controls autoplay muted></video></div>
      <script>
      const video = document.querySelector('video'); const ms = new MediaSource(); video.src = URL.createObjectURL(ms);
      ms.addEventListener('sourceopen', async () => {
        const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
        sb.changeType('video/webm; codecs="vp8"');
        sb.addEventListener('updateend', () => { if(ms.readyState === 'open') ms.endOfStream(); }, {once:true});
        sb.appendBuffer(await (await fetch('/fixture.webm')).arrayBuffer());
        video.play().catch(()=>{});
      }, {once:true});
      </script>`});
    return request.continue();
  });
  await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await page.waitForFunction(() => document.querySelector('#pawse-protection-root')?.shadowRoot?.textContent.includes('pause and pick another'), {timeout: 30000});
  const held = await page.evaluate(() => ({time: document.querySelector('video').currentTime, paused: document.querySelector('video').paused}));
  assert(held.paused && held.time < 6 && held.time > 4, JSON.stringify(held));
  assert(calls.some(c => c.start === 6 && c.frames.length === 3));
  assert(calls.every(c => c.ageBand === '6-8' && c.customRules[0] === 'Avoid scary monsters'));
  assert(calls.every(c => c.frames.every(f => f.jpeg.startsWith('data:image/jpeg;base64,'))));
  await page.screenshot({path: path.join(out, 'blocked.png')});
  console.log('PASS: captured future frames, transmitted parent rules, stopped before flagged 6s boundary', held);

  delay = 800;
  await page.$eval('video', v => { v.currentTime = 18; v.play().catch(() => {}); });
  await page.waitForFunction(() => document.querySelector('#pawse-protection-root')?.shadowRoot?.textContent.includes('checking ahead'), {timeout:5000});
  assert(await page.$eval('video', v => v.paused));
  await page.waitForFunction(() => document.querySelector('#pawse-protection-root')?.shadowRoot?.textContent.includes('pause and pick another'), {timeout:15000});
  assert(calls.some(c => c.start === 18));
  console.log('PASS: seeking into an unchecked window holds and prioritizes the new position');
  delay = 100;

  // Offline results cannot clear a fresh timeline after a settings change.
  fail = true;
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({url:'https://www.youtube.com/*'});
    await chrome.tabs.sendMessage(tab.id, {type:'refresh_protection'});
  });
  await page.waitForFunction(() => document.querySelector('#pawse-protection-root')?.shadowRoot?.textContent.includes('cannot reach'), {timeout:15000});
  assert(await page.$eval('video', v => v.paused));
  console.log('PASS: backend failure holds playback');

  // The parent's override reaches the content controller and releases playback.
  const extensionId = new URL(target.url()).host;
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // Approval needs the parent PIN (test-only PIN set here); a wrong PIN must not release playback.
  const approvals = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({url:'https://www.youtube.com/*'});
    const set = await chrome.runtime.sendMessage({type:'set_parent_pin', pin:'2468'});
    const wrong = await chrome.runtime.sendMessage({type:'allow_once', videoId:'aqz-KE-bpKQ', tabId:tab.id, pin:'1111'});
    await new Promise(r => setTimeout(r, 700));
    const right = await chrome.runtime.sendMessage({type:'allow_once', videoId:'aqz-KE-bpKQ', tabId:tab.id, pin:'2468'});
    return {set: set?.ok, wrong: wrong?.ok, right: right?.ok};
  });
  assert.deepEqual([approvals.set, approvals.wrong, approvals.right], [true, false, true], JSON.stringify(approvals));
  await page.waitForFunction(() => !document.querySelector('video').paused, {timeout:5000});
  console.log('PASS: wrong parent PIN rejected; correct PIN override releases playback');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({held, calls: calls.map(({frames, ...c}) => ({...c, frameCount:frames.length})), errors}, null, 2));
} catch (error) {
  if (page) {
    console.error('Browser state:', await page.evaluate(() => ({
      hook: window.__lookahead?.summary(),
      overlay: document.querySelector('#pawse-protection-root')?.shadowRoot?.querySelector('#surface')?.textContent
    })).catch(() => ({})));
    console.error('Relay calls:', calls.map(c => ({start:c.start, frames:c.frames.length})));
    await page.screenshot({path:path.join(out, 'failure.png')}).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => relay.close(resolve));
}
