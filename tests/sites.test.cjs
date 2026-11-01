const {test} = require('node:test');
const assert = require('node:assert/strict');
const {videoKey, siteFor, isPageKey, isValidKey} = require('../sites.js');

test('YouTube and YouTube Kids keep bare 11-character IDs', () => {
  assert.equal(videoKey('https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=5'), 'aqz-KE-bpKQ');
  assert.equal(videoKey('https://www.youtubekids.com/watch?v=v85o0PgCQyw'), 'v85o0PgCQyw');
  assert.equal(videoKey('https://www.youtube.com/'), '');            // no feeds on YouTube
  assert.equal(videoKey('https://www.youtube.com/shorts/aqz-KE-bpKQ'), '');
});

test('other supported sites get prefixed keys from their video URLs', () => {
  assert.equal(videoKey('https://www.tiktok.com/@nasa/video/7675478347278863629'), 'tiktok:7675478347278863629');
  assert.equal(videoKey('https://www.instagram.com/nasa/reel/DfF3eqGSKKc/'), 'instagram:DfF3eqGSKKc');
  assert.equal(videoKey('https://x.com/NASA/status/1882872996031066248'), 'x:1882872996031066248');
  assert.equal(videoKey('https://www.reddit.com/r/aww/comments/1abc2de/cute/'), 'reddit:1abc2de');
  assert.equal(videoKey('https://www.snapchat.com/@a/spotlight/W7_EDlXWTBiXAEEn'), 'snapchat:W7_EDlXWTBiXAEEn');
  assert.equal(videoKey('https://www.dailymotion.com/video/xbnjmwy'), 'dailymotion:xbnjmwy');
});

test('feeds without a video URL get a page key; unsupported sites get nothing', () => {
  const key = videoKey('https://www.tiktok.com/foryou');
  assert.ok(isPageKey(key) && key.startsWith('tiktok:page-'));
  assert.equal(key, videoKey('https://www.tiktok.com/foryou?lang=en'));
  for (const url of ['https://www.facebook.com/watch', 'https://www.twitch.tv/nasa', 'http://www.tiktok.com/foryou', 'not a url']) {
    assert.equal(videoKey(url), ''); assert.equal(siteFor(url), null);
  }
});

test('every generated key passes the shared validator used by worker and backend', () => {
  for (const url of ['https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'https://www.tiktok.com/foryou',
    'https://www.reddit.com/r/aww/', 'https://geo.dailymotion.com/player/xtv3w.html?video=xbnjmwy']) {
    assert.ok(isValidKey(videoKey(url)), url);
  }
  assert.ok(!isValidKey('https://www.youtube.com/watch?v=x'));
});
