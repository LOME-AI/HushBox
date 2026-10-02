import { extractBlocks, extractTag } from './s3-xml.js';
import type { ListPage } from '../ports/index.js';

/**
 * Hand-rolled S3 ListObjectsV2 XML reader over the shared tag helpers
 * (`s3-xml.ts`, which carries the namespace and entity-decoding rules).
 * Extracts `<Contents>` blocks (key, lastModified, size) plus
 * `<IsTruncated>`/`<NextContinuationToken>`.
 *
 * A `<Contents>` block missing `<Key>`, `<LastModified>` or `<Size>`, a
 * non-numeric `<Size>`, and an unparseable `<LastModified>` are all malformed
 * responses: the parser throws (the adapter maps it to an `unavailable`
 * DomainError) rather than silently dropping the object from a GC listing. A
 * dropped object is never reclaimed, and so is one whose Invalid Date makes
 * the collector's age filter compare against NaN.
 */
export function parseListObjectsV2Response(xml: string): ListPage {
  const objects: { key: string; uploaded: Date; size: number }[] = [];
  for (const block of extractBlocks(xml, 'Contents')) {
    const key = extractTag(block, 'Key');
    const lastModified = extractTag(block, 'LastModified');
    const sizeRaw = extractTag(block, 'Size');
    if (key === undefined || lastModified === undefined || sizeRaw === undefined) {
      throw new TypeError('ListObjectsV2 response has a Contents block missing a required tag');
    }
    const size = Number.parseInt(sizeRaw, 10);
    if (!Number.isFinite(size)) {
      throw new TypeError('ListObjectsV2 response has a non-numeric Size');
    }
    const uploaded = new Date(lastModified);
    if (Number.isNaN(uploaded.getTime())) {
      throw new TypeError('ListObjectsV2 response has an unparseable LastModified');
    }
    objects.push({ key, uploaded, size });
  }
  const truncated = extractTag(xml, 'IsTruncated') === 'true';
  const nextContinuationToken = truncated ? extractTag(xml, 'NextContinuationToken') : undefined;
  return {
    objects,
    ...(nextContinuationToken !== undefined && { nextCursor: nextContinuationToken }),
  };
}
