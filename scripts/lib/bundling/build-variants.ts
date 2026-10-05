/**
 * What each release build variant bakes in place of the production environment
 * file its own job generates, and which web dist directories each one writes.
 *
 * The env generator renders every variant's block from this declaration, and
 * the bundle verifier admits exactly these keys to differ from that file in a
 * shipped bundle. It lives here rather than in the generator because the
 * verifier is reachable from a Vite configuration under plain Node, which
 * cannot resolve the generator's own imports.
 */
import type { envConfig } from '../../../packages/shared/src/env/env.config.ts';

/**
 * The values each variant's block binds in place of that file, and so the only
 * keys whose baked value may differ from it: the bundle verifier holds every
 * other key to the file.
 *
 * Each native job builds its own bundle: the platform flag is compiled into the
 * JavaScript, so a bundle built elsewhere carries that build's platform into
 * this one's artifact with no other symptom. The OTA loop builds every
 * platform's bundle from the `build-env-mobile` block and sets the platform per
 * bundle in shell, over the block's base value; each of those bundles is held
 * to the native variant of its platform by {@link OTA_DIST_VARIANTS}.
 */
export const BUILD_VARIANT_OVERRIDES = {
  'build-env': {},
  'build-env-mobile': {},
  'build-env-ios': { VITE_PLATFORM: 'ios' },
  'build-env-android': { VITE_PLATFORM: '${{ inputs.vite-platform }}' },
} as const satisfies Record<string, Partial<Record<keyof typeof envConfig, string>>>;

/** A release build variant, named by the marker of the block it generates. */
export type BuildVariant = keyof typeof BUILD_VARIANT_OVERRIDES;

/** The variant whose build the web origin serves. */
const WEB_BUILD_VARIANT: BuildVariant = 'build-env';

/** The dist directory an app builds into unless a build asks for another one. */
export const PRIMARY_DIST_DIR = 'dist';

/**
 * The variant each OTA dist directory is held to. The OTA loop names a bundle's
 * directory after the platform it sets the platform flag to, which is the
 * override the native variant of that platform declares.
 */
const OTA_DIST_VARIANTS: ReadonlyMap<string, BuildVariant> = new Map([
  ['dist-ios', 'build-env-ios'],
  ['dist-android', 'build-env-android'],
  ['dist-android-direct', 'build-env-android'],
]);

/**
 * The keys a web dist may bake in place of the production environment file:
 * the ones the variants that write it declare. The primary dist is the web
 * build's where it is served over HTTP, and otherwise a native build's, whose
 * variants are the ones the OTA dists are held to.
 */
export function overriddenKeysFor(distributionDirName: string, servedOverHttp: boolean): string[] {
  const ota = OTA_DIST_VARIANTS.get(distributionDirName);
  if (ota === undefined && distributionDirName !== PRIMARY_DIST_DIR) {
    throw new Error(
      `${distributionDirName} is written by no build variant, so nothing declares what it may ` +
        `bake in place of the production environment file`
    );
  }
  let variants: BuildVariant[] = [...new Set(OTA_DIST_VARIANTS.values())];
  if (ota !== undefined) variants = [ota];
  else if (servedOverHttp) variants = [WEB_BUILD_VARIANT];
  return [...new Set(variants.flatMap((variant) => Object.keys(BUILD_VARIANT_OVERRIDES[variant])))];
}
