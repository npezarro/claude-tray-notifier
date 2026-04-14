const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateToken } = require('../lib/auth');

describe('validateToken', () => {
  it('returns true for matching tokens', () => {
    assert.strictEqual(validateToken('abc123', 'abc123'), true);
  });

  it('returns false for mismatched tokens', () => {
    assert.strictEqual(validateToken('abc123', 'xyz789'), false);
  });

  it('returns false when provided is null', () => {
    assert.strictEqual(validateToken(null, 'abc123'), false);
  });

  it('returns false when expected is null', () => {
    assert.strictEqual(validateToken('abc123', null), false);
  });

  it('returns false when both are null', () => {
    assert.strictEqual(validateToken(null, null), false);
  });

  it('returns false when provided is empty string', () => {
    assert.strictEqual(validateToken('', 'abc123'), false);
  });

  it('returns false when expected is empty string', () => {
    assert.strictEqual(validateToken('abc123', ''), false);
  });

  it('returns false for different lengths', () => {
    assert.strictEqual(validateToken('short', 'muchlongertoken'), false);
  });

  it('handles long tokens', () => {
    const long = 'a'.repeat(256);
    assert.strictEqual(validateToken(long, long), true);
  });

  it('returns false when provided is undefined', () => {
    assert.strictEqual(validateToken(undefined, 'abc'), false);
  });
});
