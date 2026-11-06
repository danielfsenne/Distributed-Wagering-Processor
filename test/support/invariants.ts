const intentionallyCorrupted = new Set<string>();

export function excludeFromGlobalInvariant(walletId: string): void {
  intentionallyCorrupted.add(walletId);
}

export function intentionallyCorruptedWallets(): string[] {
  return [...intentionallyCorrupted];
}
