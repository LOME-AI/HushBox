/**
 * Extracts the slice of a wrangler-dev log that belongs to a specific mobile-test
 * run, filtering out request lines from sibling sessions hitting the same API.
 *
 * Inputs are the raw log content (already read from disk by the caller), the
 * runId written into the START/END markers by mobile-test, and the X-App-Version
 * value the mobile APK sends. The result is suitable for writing directly into
 * the maestro-results report.
 */

export const MARKER_PREFIX = '===== MOBILE-TEST';

export interface ExtractSliceOptions {
  rawLog: string;
  runId: string;
  mobileVersion: string;
}

const REQ_LINE_PREFIX = '[req] ';

function isStartMarker(line: string, runId: string): boolean {
  return line.startsWith(`${MARKER_PREFIX} ${runId} START `);
}

function isEndMarker(line: string, runId: string): boolean {
  return line.startsWith(`${MARKER_PREFIX} ${runId} END `);
}

/**
 * Keeps non-request lines unconditionally (wrangler banners, errors, our own
 * markers, stack traces). Filters [req] lines to those whose v=<version> token
 * matches the mobile APK build.
 */
function keepLine(line: string, mobileVersion: string): boolean {
  if (!line.startsWith(REQ_LINE_PREFIX)) return true;
  return line.includes(` v=${mobileVersion}`);
}

export function extractRelevantSlice(options: ExtractSliceOptions): string {
  const lines = options.rawLog.split('\n');

  // Latest START wins — defensive against the unlikely case of runId reuse,
  // and aligns with the "most recent run" mental model when reading by hand.
  let startIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined && isStartMarker(line, options.runId)) {
      startIndex = index;
      break;
    }
  }
  if (startIndex === -1) return '';

  let endIndex = lines.length - 1;
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line !== undefined && isEndMarker(line, options.runId)) {
      endIndex = index;
      break;
    }
  }

  const slice = lines.slice(startIndex, endIndex + 1);
  return slice.filter((line) => keepLine(line, options.mobileVersion)).join('\n');
}
