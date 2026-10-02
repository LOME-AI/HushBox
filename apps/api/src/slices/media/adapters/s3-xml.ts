/**
 * The tag reader both S3 response parsers in this slice are built from (the
 * `ListObjectsV2` listing and the bucket lifecycle configuration). No XML
 * parser dependency — the response shapes are well-defined and stable — and
 * one implementation rather than one per parser, because two readers that
 * decoded entities differently would disagree about the same bytes.
 *
 * Tag matching tolerates an optional XML namespace prefix (`s3:Contents`) and
 * self-closing tags (`<IsTruncated/>` reads as an empty string).
 */

/**
 * Tag content is XML-entity-decoded for the five named entities S3 emits.
 * Without decoding, a key like `foo&bar` arrives as `foo&amp;bar` and the GC
 * orphan check (comparing against DB-stored, already-decoded keys) would
 * mismatch — and delete a live object. Numeric character references are not
 * used by S3 and are intentionally not handled.
 */
function decodeXmlEntities(value: string): string {
  // &amp; must decode last: "&amp;lt;" is the encoding of the literal
  // "&lt;", and decoding &amp; first would re-expose it to the &lt; pass
  // (over-decoding to "<"). replaceAll never rescans replaced text, so a
  // trailing &amp; pass cannot cascade either.
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

const NS_PREFIX = String.raw`(?:[a-zA-Z][\w.-]*:)?`;

/** The decoded content of the first `tag` anywhere in `xml`, or nothing. */
export function extractTag(xml: string, tag: string): string | undefined {
  const selfClosing = new RegExp(String.raw`<${NS_PREFIX}${tag}\s*/>`);
  if (selfClosing.test(xml)) {
    return '';
  }
  const regex = new RegExp(
    String.raw`<${NS_PREFIX}${tag}(?:\s[^>]*)?>([^<]*)</${NS_PREFIX}${tag}>`
  );
  const raw = regex.exec(xml)?.[1];
  return raw === undefined ? undefined : decodeXmlEntities(raw);
}

/**
 * Every `tag` element in document order, each with its own wrapper tags kept —
 * the wrapper is harmless to a later {@link extractTag} over the block, and
 * keeping it avoids a capture group whose index could be absent.
 */
export function extractBlocks(xml: string, tag: string): string[] {
  return extractBlocksOfAny(xml, [tag]);
}

/**
 * Every element of any of `tags`, interleaved in document order. Reading each
 * tag with its own pass would sort the blocks by tag instead, which loses the
 * order between them — and in a versions listing that order is the data: a
 * delete marker and the version it hid are different tags, and which came
 * first is what says the version is no longer current.
 */
export function extractBlocksOfAny(xml: string, tags: readonly string[]): string[] {
  const regex = new RegExp(
    String.raw`<${NS_PREFIX}(${tags.join('|')})>[\s\S]*?</${NS_PREFIX}\1>`,
    'g'
  );
  return [...xml.matchAll(regex)].map((match) => match[0]);
}
