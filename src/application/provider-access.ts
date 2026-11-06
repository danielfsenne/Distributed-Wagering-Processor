import { ProviderNotAllowedError } from './errors';

export interface ProviderPrincipal {
  subject: string;
  providerIds: readonly string[] | '*';
}

export const TRUSTED_INTERNAL_PRINCIPAL: ProviderPrincipal = { subject: 'internal', providerIds: '*' };

export function principalFor(subject: string, allowedProviders: string): ProviderPrincipal {
  const trimmed = allowedProviders.trim();
  if (trimmed === '' || trimmed === '*') {
    return { subject, providerIds: '*' };
  }
  return {
    subject,
    providerIds: trimmed
      .split(',')
      .map((providerId) => providerId.trim())
      .filter(Boolean),
  };
}

export function assertMayActFor(principal: ProviderPrincipal, providerId: string): void {
  if (principal.providerIds !== '*' && !principal.providerIds.includes(providerId)) {
    throw new ProviderNotAllowedError(principal.subject, providerId);
  }
}
