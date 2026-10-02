export interface SplitTitle {
  readonly lead: string;
  readonly last: string;
}

/**
 * Splits a trimmed title before its final word, so a caller can keep that word
 * together with whatever follows it. `lead` keeps its trailing whitespace, so
 * `lead + last` is the trimmed title.
 */
export function splitLastWord(title: string): SplitTitle {
  const trimmed = title.trim();
  const at = trimmed.search(/\S*$/);
  return { lead: trimmed.slice(0, at), last: trimmed.slice(at) };
}
