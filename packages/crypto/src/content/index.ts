/**
 * A browser-safe door onto the content layer. The root barrel re-exports the
 * OPAQUE modules, whose vendored dependency runs top-level statements no
 * tree-shaker can drop, so a consumer that only encrypts reaches these two
 * names here instead and never loads that chain.
 *
 * Every name published here must have a consumer reaching it through this
 * file: an exports-map target is an entry file, so a name added for symmetry
 * is an export nothing imports.
 */
export { generateKeyPair } from '../primitives/keys.js';
export { encryptTextForEpoch } from './message-encrypt.js';
