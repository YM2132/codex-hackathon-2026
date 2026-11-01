// Stub backend for manual pipeline testing WITHOUT an OpenAI key. Every window is answered "safe".
// It proves capture → worker → relay → guard works on a site; it is NOT moderation.
// Usage: node lookahead/harness/stub-relay.mjs   (stop the real backend first; logs to stdout)
import http from 'node:http';
http.createServer(async (req, res) => {
  if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"model":"STUB"}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let scan; try { scan = JSON.parse(raw); } catch { res.writeHead(422); res.end('{}'); return; }
  console.log(new Date().toISOString().slice(11, 19), 'scan', JSON.stringify({key: scan.videoId, window: `${scan.start}-${scan.end}`,
    frames: scan.frames?.length, kb: Math.round(raw.length / 1024)}));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({videoId: scan.videoId, start: scan.start, end: scan.end, status: 'safe', category: null,
    probability: 0, threshold: .7, probabilities: {}, frameCount: scan.frames?.length || 0, apiSeconds: 0,
    model: 'STUB', preview: false, provenance: 'live', audioAnalyzed: false}));
}).listen(8000, '127.0.0.1', () => console.log('STUB relay on http://127.0.0.1:8000 (every window = safe)'));
