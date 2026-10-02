/**
 * A username in the form it is stored and compared in. The brand exists so
 * that checks which only hold against the stored form — the reserved list
 * above all — cannot be handed raw input that would slip past them.
 */
export type NormalizedUsername = string & { readonly __brand: 'NormalizedUsername' };

export function normalizeUsername(input: string): NormalizedUsername {
  return input.trim().toLowerCase().replaceAll(/\s+/g, '_') as NormalizedUsername;
}

export function normalizeIdentifier(raw: string): string {
  return raw.includes('@') ? raw : normalizeUsername(raw);
}

/**
 * The identifier in the form it is stored and compared in: emails are stored
 * lowercased, usernames normalized. Distinct from `normalizeIdentifier`, which
 * leaves an email's case alone because that is the form the user typed and the
 * server still resolves case-insensitively.
 *
 * Shared because the recovery-reset proof binds this exact string on both
 * sides: the browser derives the proof over it and the API re-derives the
 * expected proof over it. Two implementations that drifted by so much as a
 * case rule would fail every reset whose identifier is not already canonical.
 */
export function canonicalIdentifier(identifier: string): string {
  return identifier.includes('@') ? identifier.toLowerCase() : normalizeUsername(identifier);
}

export function displayUsername(stored: string): string {
  return stored
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
