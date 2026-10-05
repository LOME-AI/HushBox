/**
 * The spellings a value can take inside a shipped artifact: written as itself,
 * escaped inside a JSON or JavaScript string, or base64-encoded inside a larger
 * blob — a data URI, an embedded file, a string resource.
 */

interface EncodedForm {
  /** Names the spelling in a hit's report. */
  readonly form: string;
  /** The text whose occurrence means the value is present. */
  readonly text: string;
}

/**
 * Characters to drop from the front of a base64 encoding whose input was
 * preceded by 0, 1 or 2 bytes of other content: those characters mix bits of
 * the preceding bytes with the value's own.
 */
const LEADING_MIXED = [0, 2, 3] as const;

/**
 * The value's own run of characters inside any base64 blob carrying it, at
 * each of the three byte alignments it can sit at. Only whole 3-byte groups
 * are kept, because the characters after them mix the value's last bits with
 * whatever follows it.
 */
function base64Fragments(value: Buffer): string[] {
  return LEADING_MIXED.map((drop, offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), value]).toString('base64');
    const wholeGroups = Math.floor((offset + value.length) / 3) * 4;
    return encoded.slice(drop, wholeGroups);
  });
}

/** Every distinct spelling of `value` the sweep looks for. */
export function encodedForms(value: string): EncodedForm[] {
  const forms: EncodedForm[] = [{ form: 'literal', text: value }];
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) forms.push({ form: 'json-escaped', text: escaped });
  for (const fragment of base64Fragments(Buffer.from(value))) {
    forms.push({ form: 'base64', text: fragment });
    const urlSafe = fragment.replaceAll('+', '-').replaceAll('/', '_');
    if (urlSafe !== fragment) forms.push({ form: 'base64url', text: urlSafe });
  }
  return forms;
}
