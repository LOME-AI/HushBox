import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { parseListObjectVersionsResponse } from './backup-versions-xml.js';

function version(key: string, instantMs: number, versionId = 'v'): string {
  return `<Version><Key>${key}</Key><VersionId>${versionId}</VersionId><IsLatest>true</IsLatest><LastModified>${isoAt(instantMs)}</LastModified><Size>1</Size></Version>`;
}

function deleteMarker(key: string, instantMs: number): string {
  return `<DeleteMarker><Key>${key}</Key><VersionId>d</VersionId><IsLatest>true</IsLatest><LastModified>${isoAt(instantMs)}</LastModified></DeleteMarker>`;
}

function listing(body: string, tail = '<IsTruncated>false</IsTruncated>'): string {
  return `<ListVersionsResult>${body}${tail}</ListVersionsResult>`;
}

describe('parseListObjectVersionsResponse', () => {
  it('reads a version entry as its key and the instant the store took it', () => {
    const parsed = parseListObjectVersionsResponse(
      listing(version('repository/a', TEST_DAY_START))
    );

    expect(parsed.versions).toEqual([
      { key: 'repository/a', lastModified: new Date(TEST_DAY_START) },
    ]);
  });

  it('reads a delete marker as an entry beside the versions', () => {
    const parsed = parseListObjectVersionsResponse(
      listing(deleteMarker('repository/a', TEST_DAY_START))
    );

    expect(parsed.versions).toEqual([
      { key: 'repository/a', lastModified: new Date(TEST_DAY_START) },
    ]);
  });

  it('keeps document order across the two entry kinds, which is what dates each version', () => {
    // The marker hid the version below it; reading the two kinds separately
    // would lose which one is newer and so lose the hiding instant.
    const body =
      deleteMarker('repository/a', TEST_DAY_START) +
      version('repository/a', TEST_DAY_START - DAY_MS, 'old');

    const parsed = parseListObjectVersionsResponse(listing(body));

    expect(parsed.versions.map((entry) => entry.lastModified.getTime())).toEqual([
      TEST_DAY_START,
      TEST_DAY_START - DAY_MS,
    ]);
  });

  it('reads an empty listing as no entries and no continuation', () => {
    expect(parseListObjectVersionsResponse(listing(''))).toEqual({ versions: [] });
  });

  it('carries both markers of a truncated listing so a split key resumes mid-key', () => {
    const parsed = parseListObjectVersionsResponse(
      listing(
        version('repository/a', TEST_DAY_START),
        '<IsTruncated>true</IsTruncated><NextKeyMarker>repository/a</NextKeyMarker><NextVersionIdMarker>v9</NextVersionIdMarker>'
      )
    );

    expect(parsed.nextCursor).toEqual({ keyMarker: 'repository/a', versionIdMarker: 'v9' });
  });

  it('carries the empty version-id marker a page ending on a key boundary names', () => {
    // The shape the object store emits, confirmed against the live store in
    // `backup-repository-s3.integration.test.ts`: the element is always
    // present and is empty at a key boundary, so the reader resumes with
    // `version-id-marker=` rather than without the parameter.
    const parsed = parseListObjectVersionsResponse(
      listing(
        version('repository/a', TEST_DAY_START),
        '<IsTruncated>true</IsTruncated><NextKeyMarker>repository/a</NextKeyMarker><NextVersionIdMarker></NextVersionIdMarker>'
      )
    );

    expect(parsed.nextCursor).toEqual({ keyMarker: 'repository/a', versionIdMarker: '' });
  });

  it('carries a key marker alone when a response names no version-id marker at all', () => {
    // Not a shape the store under test emits; the parser tolerates it because
    // resuming from a key marker alone is still a resume, where refusing the
    // page would end the scan and read as a clean repository.
    const parsed = parseListObjectVersionsResponse(
      listing(
        version('repository/a', TEST_DAY_START),
        '<IsTruncated>true</IsTruncated><NextKeyMarker>repository/a</NextKeyMarker>'
      )
    );

    expect(parsed.nextCursor).toEqual({ keyMarker: 'repository/a' });
  });

  it('throws on a truncated listing that names no continuation, rather than stopping short', () => {
    expect(() =>
      parseListObjectVersionsResponse(
        listing(version('repository/a', TEST_DAY_START), '<IsTruncated>true</IsTruncated>')
      )
    ).toThrow(TypeError);
  });

  it('throws on an entry missing its key rather than dropping it from the scan', () => {
    const body = `<Version><LastModified>${isoAt(TEST_DAY_START)}</LastModified></Version>`;

    expect(() => parseListObjectVersionsResponse(listing(body))).toThrow(TypeError);
  });

  it('throws on an entry missing its timestamp, which is what dates the entry below it', () => {
    const body = '<Version><Key>repository/a</Key></Version>';

    expect(() => parseListObjectVersionsResponse(listing(body))).toThrow(TypeError);
  });

  it('throws on an unparseable timestamp rather than scanning against an invalid date', () => {
    const body =
      '<Version><Key>repository/a</Key><LastModified>not-a-date</LastModified></Version>';

    expect(() => parseListObjectVersionsResponse(listing(body))).toThrow(TypeError);
  });

  it('tolerates a namespace prefix on the entry tags', () => {
    const body = `<s3:Version><s3:Key>repository/a</s3:Key><s3:LastModified>${isoAt(TEST_DAY_START)}</s3:LastModified></s3:Version>`;

    expect(parseListObjectVersionsResponse(listing(body)).versions).toEqual([
      { key: 'repository/a', lastModified: new Date(TEST_DAY_START) },
    ]);
  });
});
