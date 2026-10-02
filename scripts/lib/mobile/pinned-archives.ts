import { readFileSync } from 'node:fs';

import { verifySha256 } from '../sha256-checksum.js';

/** A downloaded archive and the SHA-256 its bytes must have before anything unpacks them. */
export interface PinnedArchive {
  readonly url: string;
  readonly sha256: string;
}

/**
 * The Maestro CLI release the mobile flows run under. The CI workflow's Maestro
 * cache key carries this version, so a bump here is a cache miss there.
 */
export const MAESTRO_VERSION = '2.11.0';

/** SHA-256 from the release's own `checksums_sha256.txt` asset. */
export const MAESTRO_ARCHIVE: PinnedArchive = {
  url: `https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip`,
  sha256: '5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a',
};

/**
 * The Android command-line tools build the SDK install starts from. The CI
 * workflow's Android SDK cache key carries this build number.
 */
export const CMDLINE_TOOLS_BUILD = '11076708';

/**
 * Google's repository manifest publishes only a SHA-1 for this build; the
 * SHA-256 is of the download whose SHA-1 matched that manifest entry.
 */
export const CMDLINE_TOOLS_ARCHIVE: PinnedArchive = {
  url: `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip`,
  sha256: '2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258',
};

/** Throws unless the file at `file` hashes to the archive's pinned SHA-256. */
export function verifyArchive(file: string, archive: PinnedArchive): void {
  verifySha256(readFileSync(file), archive.sha256, archive.url);
}
