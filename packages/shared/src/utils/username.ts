export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase().replaceAll(/\s+/g, '_');
}

export function normalizeIdentifier(raw: string): string {
  return raw.includes('@') ? raw : normalizeUsername(raw);
}

export function displayUsername(stored: string): string {
  return stored
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
