const {test} = require('node:test');
const assert = require('node:assert/strict');
const {evaluate} = require('../guard.js');
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
