/**
 * The path prefix the admin origin serves its own copy of the marketing site
 * under.
 *
 * Shared because the two halves of that arrangement sit in different trees: the
 * build tooling emits the copy under this prefix and writes its headers, and the
 * admin app's click overlay frames a page of it by the same prefix. A frame
 * built on a second spelling would ask the admin origin for a page nothing
 * serves, and the overlay would show an empty page rather than a failure.
 */
export const ADMIN_PREVIEW_PREFIX = 'preview';

/**
 * The admin origin's own URL for the framed copy of the page the site serves at
 * `sitePath`.
 *
 * The trailing slash is load-bearing rather than cosmetic, and the three forms
 * of this URL are not interchangeable. The copy is built as directory pages, so
 * the only file under the prefix is `<sitePath>/index.html`. The slash-less
 * `/preview<sitePath>` is answered with the admin shell, a different document
 * the overlay would read and badge as though it were the copy; the development
 * and preview servers agree on that, and the generated header file keys no
 * block there because of it. `/preview<sitePath>/index.html` is answered with
 * the copy, but it matches no per-page block in that file, whose patterns are
 * exact per path, so it is served under the admin shell's own block and that
 * block's `X-Frame-Options: DENY` refuses the frame. `/preview<sitePath>/` is
 * the only form the header file keys a framable block at, and the one the
 * page's own canonical link states.
 */
export function adminPreviewPath(sitePath: string): string {
  return `/${ADMIN_PREVIEW_PREFIX}${sitePath}/`;
}
