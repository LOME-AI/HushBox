import type path from 'node:path';

/**
 * Whether `candidate` lies outside `root`, asked through an injected `path`
 * flavour so the branch a host would never take is still selectable here.
 *
 * A leading `..` is the answer only while both paths share a root: across
 * Windows drives `relative` hands back the absolute target instead, and a
 * target on another drive is outside by definition. The bare `..` reading
 * therefore calls a cross-drive target INSIDE the root, which is a false green
 * wherever a test asserts containment rather than escape.
 */
export function isOutsideRoot(pathApi: typeof path, root: string, candidate: string): boolean {
  const fromRoot = pathApi.relative(root, candidate);
  return fromRoot.startsWith('..') || pathApi.isAbsolute(fromRoot);
}
