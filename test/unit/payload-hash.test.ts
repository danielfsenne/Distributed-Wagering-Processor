import { describe, expect, it } from 'bun:test';
import { canonicalJson, payloadHash } from '../../src/application/idempotency/payload-hash';

const payload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p',
  walletId: 'w',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payload hash', () => {
  it('sorts keys recursively and drops undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });

  it('is independent of key order', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'w',
      playerId: 'p',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(payloadHash(reordered)).toBe(payloadHash(payload));
  });

  it('differs when any business field differs', () => {
    expect(payloadHash({ ...payload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(
      payloadHash(payload),
    );
    expect(payloadHash({ ...payload, kind: 'WIN' })).not.toBe(payloadHash(payload));
  });

  it('is a 64-char sha256 hex digest', () => {
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});
