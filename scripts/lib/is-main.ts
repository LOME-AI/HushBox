import { pathToFileURL } from 'node:url';

/**
 * Tests whether a module is being executed as the main entry point.
 * Cross-platform alternative to comparing `import.meta.url` against a
 * concatenated `file://` + process.argv[1] — that pattern fails on Windows
 * where argv[1] uses backslashes while import.meta.url uses forward slashes.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return importMetaUrl === pathToFileURL(argv1).href;
}
