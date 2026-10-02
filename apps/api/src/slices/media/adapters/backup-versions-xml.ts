import { extractBlocksOfAny, extractTag } from './s3-xml.js';
import type { BackupVersionPage, BackupObjectVersion } from '../ports/index.js';

/**
 * Hand-rolled reader for an S3 `ListObjectVersions` response, reduced to what
 * the retention audit judges on: each entry's key and the instant the store
 * took it, in the order the store listed them.
 *
 * Versions and delete markers are read as one interleaved sequence rather than
 * as two lists. The audit dates a noncurrent version from the entry above it in
 * the listing, and that entry is as often a delete marker as a version — read
 * apart, the two lists no longer say which came first.
 *
 * A malformed entry throws rather than being dropped, for the reason the
 * sibling listing parser does the same: an entry silently missing from the scan
 * is an overdue version the audit never reports, which is the hole this check
 * exists to close. A truncated listing naming no continuation throws for the
 * same reason — resuming from nothing would end the scan early and read as
 * clean.
 */
export function parseListObjectVersionsResponse(xml: string): BackupVersionPage {
  const versions: BackupObjectVersion[] = [];
  for (const block of extractBlocksOfAny(xml, ['Version', 'DeleteMarker'])) {
    const key = extractTag(block, 'Key');
    const lastModifiedRaw = extractTag(block, 'LastModified');
    if (key === undefined || lastModifiedRaw === undefined) {
      throw new TypeError('ListObjectVersions response has an entry missing a required tag');
    }
    const lastModified = new Date(lastModifiedRaw);
    if (Number.isNaN(lastModified.getTime())) {
      throw new TypeError('ListObjectVersions response has an unparseable LastModified');
    }
    versions.push({ key, lastModified });
  }
  if (extractTag(xml, 'IsTruncated') !== 'true') {
    return { versions };
  }
  const keyMarker = extractTag(xml, 'NextKeyMarker');
  if (keyMarker === undefined) {
    throw new TypeError('ListObjectVersions response is truncated but names no continuation');
  }
  const versionIdMarker = extractTag(xml, 'NextVersionIdMarker');
  return {
    versions,
    nextCursor: { keyMarker, ...(versionIdMarker === undefined ? {} : { versionIdMarker }) },
  };
}
