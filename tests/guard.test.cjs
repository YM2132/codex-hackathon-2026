const {test} = require('node:test');
const assert = require('node:assert/strict');
const {evaluate, videoIdFromUrl} = require('../guard.js');
test('accepts any standard YouTube watch ID, not just the demo', () => {
  for (const id of ['XnWESGXnGwY', 'aqz-KE-bpKQ', 'wiiFgsDJ8xk']) {
    assert.equal(videoIdFromUrl(`https://www.youtube.com/watch?v=${id}&t=5`), id);
  }
  for (const url of ['https://example.com/watch?v=aqz-KE-bpKQ', 'https://www.youtube.com/', 'https://www.youtube.com/watch?v=bad']) {
    assert.equal(videoIdFromUrl(url), '');
  }
});
const safe = (start, end) => ({status: 'safe', start, end});
test('holds unknown content including seeks outside cached windows', () => {
  const windows = new Map([[0, safe(0, 3)]]);
  assert.equal(evaluate(windows, 1, 30).status, 'safe');
  assert.equal(evaluate(windows, 2.5, 30).status, 'connecting');
  assert.equal(evaluate(windows, 15, 30).status, 'connecting');
});
test('stops before flagged boundary, resumes only after next window is safe', () => {
  const windows = new Map([[0, safe(0, 3)], [1, {status: 'blocked', start: 3, end: 6}]]);
  assert.equal(evaluate(windows, 2, 30).status, 'safe');
  assert.equal(evaluate(windows, 2.5, 30).status, 'blocked');
  windows.set(1, safe(3, 6));
  assert.equal(evaluate(windows, 2.5, 30).status, 'safe');
});
test('last partial window does not require nonexistent future frames', () => {
  assert.equal(evaluate(new Map([[1, safe(3, 4)]]), 3.8, 4).status, 'safe');
});
