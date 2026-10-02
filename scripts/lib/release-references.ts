/**
 * The two ref shapes a version number lives in. A release tag means the deploy
 * carrying that number shipped and was verified; a claim only reserves the
 * number for a deploy that may never ship. Readers that date or label shipped
 * code read release tags alone, which is why claims live outside `refs/tags/`.
 */

/** A release tag's name: the shape the deploy's tag step creates, and nothing else. */
export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** Where claims live. */
export const CLAIM_NAMESPACE = 'refs/version-claims';

/** The ref that claims `version`, written `X.Y.Z`. */
export function claimRef(version: string): string {
  const tag = `v${version}`;
  if (!RELEASE_TAG.test(tag)) {
    throw new Error(`Cannot claim "${version}": a claim names a version written X.Y.Z`);
  }
  return `${CLAIM_NAMESPACE}/${tag}`;
}

/** The release a claim ref reserves, as its tag name, or null for any other ref. */
export function claimedTag(ref: string): string | null {
  const prefix = `${CLAIM_NAMESPACE}/`;
  if (!ref.startsWith(prefix)) return null;
  const tag = ref.slice(prefix.length);
  return RELEASE_TAG.test(tag) ? tag : null;
}
