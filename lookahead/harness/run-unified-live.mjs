// Live YouTube smoke test. Requires the backend on port 8000; incurs API usage.
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'artifacts/unified-live-browser');
fs.mkdirSync(out, {recursive:true});
const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || undefined,
  headless:!process.env.HEADFUL, pipe:true, enableExtensions:[root],
  args:['--autoplay-policy=no-user-gesture-required', '--mute-audio'], defaultViewport:{width:1280,height:850}});
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker');
  const worker = await target.worker();
  for(let i=0;i<50;i++) {
    if(await worker.evaluate(async()=>Object.hasOwn(await chrome.storage.session.get('adultRequests'),'adultRequests'))) break;
    await new Promise(r=>setTimeout(r,100));
  }
  await worker.evaluate(()=>chrome.storage.sync.set({setupComplete:true,protectionOn:true,ageBand:'6-8',customRules:[],previewScenario:'off'}));
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => window.addEventListener('message', e => {
    if(e.data?.tag === 'lookahead-res' && e.data.result?.frames) {
      window.__sproutDecodeDiagnostic = {...e.data.result, frames:e.data.result.frames.map(({jpeg,...f})=>({...f,hasImage:!!jpeg}))};
    }
  }));
  await page.goto(`https://www.youtube.com/watch?v=${process.argv[2] || 'XnWESGXnGwY'}`,{waitUntil:'domcontentloaded',timeout:45000});
  for (const button of await page.$$('button')) {
    const text = await button.evaluate(e=>e.textContent);
    if (text?.trim() === 'Reject all') { await button.click(); break; }
  }
  const timeline=[];
  let pressedPlay = false;
  for(let i=0;i<30;i++) {
    await new Promise(r=>setTimeout(r,2000));
    const data = await page.evaluate(()=>({
      url:location.href, player:window.__lookahead?.playerState(),
      overlay:document.querySelector('#sprout-protection-root')?.shadowRoot?.querySelector('#surface')?.textContent?.trim(),
      capture:window.__lookahead?.summary().sourceBuffers.map(({id,mime,appends,bytesHeld})=>({id,mime,appends,bytesHeld})),
      decoder:window.__sproutDecodeDiagnostic
    }));
    const decisions = await worker.evaluate(()=>chrome.storage.session.get(null));
    data.decision=Object.entries(decisions).find(([k])=>k.startsWith('decision:'))?.[1];
    timeline.push(data);
    console.log(JSON.stringify({time:data.player?.currentTime,paused:data.player?.paused,status:data.decision?.status,detail:data.decision?.detail,decoder:data.decoder}));
    if (data.decision?.status === 'safe' && data.player?.paused && !pressedPlay) {
      pressedPlay = true;
      await page.click('.ytp-play-button');
    }
    if(data.decision?.provenance==='live' && ['blocked','review'].includes(data.decision.status)) break;
  }
  await page.screenshot({path:path.join(out,'youtube.png')});
  fs.writeFileSync(path.join(out,'timeline.json'),JSON.stringify(timeline,null,2));
  if(!timeline.some(d=>d.decision?.provenance==='live')) throw new Error('No live Decisions result received; see saved timeline.');
} finally { await browser.close(); }
