let linkPublicKey: string | null = null;

export function setLinkGuestAuth(publicKey: string): void {
  linkPublicKey = publicKey;
}

export function getLinkGuestAuth(): string | null {
  return linkPublicKey;
}

export function clearLinkGuestAuth(): void {
  linkPublicKey = null;
}
