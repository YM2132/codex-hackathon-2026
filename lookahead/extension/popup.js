// Single source of truth: the content-script match patterns in manifest.json.
const patterns = chrome.runtime.getManifest().content_scripts.flatMap(c => c.matches);
const hosts = patterns.map(p => new URL(p.replace('/*', '/')).hostname);
const list = document.getElementById('sites');
for (const h of hosts) { const li = document.createElement('li'); li.textContent = h; list.append(li); }
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const el = document.getElementById('status');
  let host = null; try { host = new URL(tab?.url || '').hostname; } catch (_) {}
  if (host && hosts.includes(host)) { el.className = 'status ok'; el.textContent = `Active on ${host}. Play a video to see the preview.`; }
  else { el.className = 'status no'; el.textContent = `${host || 'This page'} is not supported. Videos here are not scanned.`; }
});
