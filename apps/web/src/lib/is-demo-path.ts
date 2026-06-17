import { ROUTES } from '@hushbox/shared';

/**
 * True only for the demo document path (`/demo`) and its subpaths — used to gate
 * loading the lazy demo bundle. Exact-or-subpath, not a bare prefix, so an
 * unrelated route like `/demoxyz` never trips the demo boot.
 */
export function isDemoPath(pathname: string): boolean {
  return pathname === ROUTES.DEMO || pathname.startsWith(`${ROUTES.DEMO}/`);
}
