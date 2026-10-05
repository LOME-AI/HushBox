/** Escapes a literal so it matches itself inside a RegExp. */
function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * What a settled reasoning row reads: "Reasoned", how long where the reply
 * recorded it, the token count it spent, then any trailing fragments such as a
 * search summary. The duration is measured from the stream, so it varies run
 * to run and is absent until the stored reply replaces the live tile; the
 * pattern accepts any duration or none, and is spelled here rather than in
 * each spec that asserts it so every spec expects the same sentence.
 */
export function settledReasoningLabel(fragments: readonly string[] = []): RegExp {
  const tail = fragments.map((fragment) => ` · ${literal(fragment)}`).join('');
  const duration = String.raw`(?: for (?:\d+s|\d+m(?: \d+s)?))?`;
  return new RegExp(String.raw`^Reasoned${duration} · \d[\d,]* tokens${tail}$`);
}
