import { describe, expect, it } from 'bun:test';
import { ProviderNotAllowedError } from '../../src/application/errors';
import { TRUSTED_INTERNAL_PRINCIPAL, assertMayActFor, principalFor } from '../../src/application/provider-access';

describe('provider access', () => {
  it('builds a wildcard principal from "*" or an empty list', () => {
    expect(principalFor('sqs', '*').providerIds).toBe('*');
    expect(principalFor('sqs', ' ').providerIds).toBe('*');
  });

  it('builds a restricted principal from a comma separated list', () => {
    expect(principalFor('sqs', 'provider-a, provider-b,').providerIds).toEqual(['provider-a', 'provider-b']);
  });

  it('allows providers in the principal scope', () => {
    expect(() => assertMayActFor(TRUSTED_INTERNAL_PRINCIPAL, 'any')).not.toThrow();
    expect(() => assertMayActFor(principalFor('p', 'provider-a'), 'provider-a')).not.toThrow();
  });

  it('rejects providers outside the principal scope', () => {
    expect(() => assertMayActFor(principalFor('p', 'provider-a'), 'provider-b')).toThrow(ProviderNotAllowedError);
  });
});
