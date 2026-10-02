import { z } from 'zod';
import { MOBILE_PLATFORMS } from '@hushbox/shared';
import type { MobilePlatform } from '@hushbox/shared';
import type { Bindings } from '../../../lib/context/index.js';
import type { AppBuildsBucket } from '../ports/index.js';

/**
 * Per-native-platform sha256 (hex) of the published OTA bundle. OTA bundles are
 * built and stored per platform (`builds/<platform>/<version>.zip`) — each
 * `VITE_PLATFORM` build yields a distinct sha256 — so a single shared checksum
 * would reject every platform but the one it was computed for. The CI OTA
 * publish step computes each bundle's sha256, and the API deploy uploads it
 * into the matching binding in the secrets file it ships with the code, which
 * is why a production deploy always carries one and why
 * {@link resolvePlatformChecksum} treats a production miss as a defect.
 */
type ChecksumBinding =
  | 'APP_BUNDLE_CHECKSUM_IOS'
  | 'APP_BUNDLE_CHECKSUM_ANDROID'
  | 'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT';

/** APP_VERSION + APP_BUILDS are per-consumer bindings (not pipeline-gated). */
export interface UpdatesBindings extends Bindings {
  APP_VERSION?: string;
  APP_BUILDS?: AppBuildsBucket;
  APP_BUNDLE_CHECKSUM_IOS?: string;
  APP_BUNDLE_CHECKSUM_ANDROID?: string;
  APP_BUNDLE_CHECKSUM_ANDROID_DIRECT?: string;
}

/**
 * Maps the client's `X-HushBox-Platform` (mobile platforms only — web never
 * OTA-updates) to its checksum binding. Own-property membership doubles as the
 * platform guard: an unknown/unset/web platform has no entry, so no checksum is
 * served.
 */
const CHECKSUM_BINDING_BY_PLATFORM: Record<MobilePlatform, ChecksumBinding> = {
  ios: 'APP_BUNDLE_CHECKSUM_IOS',
  android: 'APP_BUNDLE_CHECKSUM_ANDROID',
  'android-direct': 'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT',
};

function isMobilePlatform(platform: string): platform is MobilePlatform {
  // Own-property membership, never `in`: the platform is an unauthenticated
  // header value, and `in` admits every `Object.prototype` key — each of which
  // resolves no binding and so would let any caller drive the misconfiguration
  // defect, poisoning the signal it exists to raise.
  return Object.hasOwn(CHECKSUM_BINDING_BY_PLATFORM, platform);
}

/**
 * The checksum for the requesting platform: the dev-only override first (the
 * local harness builds its bundle after env generation, so only a runtime
 * channel can carry its hash), then the deploy-published binding. Undefined
 * when the platform is unknown/unset/web — those never OTA-update, so no
 * checksum is owed and none is missing.
 *
 * The production fail-fast for the silent-misconfiguration footgun: a native
 * client refuses to install without a checksum, so a deploy that failed to
 * publish one strands every updating device behind the non-dismissable upgrade
 * modal. This defect does not soften that lockout: a device whose app version
 * is stale is already held there by `versionCheck`, which answers 426 on every
 * route outside the `/updates` prefix, and the modal's own update action runs
 * the version lookup this defect fails — so no update is reported, the install
 * never runs, and the modal never clears. What the defect buys is the only
 * report that exists: nothing on the device can say why, client-side error
 * reporting being out by design, so a 500 through the telemetry port is the
 * one place the misconfiguration is visible. Dev, CI and the local harness
 * carry no binding by construction and proceed without one.
 */
export function resolvePlatformChecksum(
  env: UpdatesBindings,
  platform: string | undefined,
  override: string | undefined,
  isProduction: boolean
): string | undefined {
  if (platform === undefined || !isMobilePlatform(platform)) return undefined;
  const binding = CHECKSUM_BINDING_BY_PLATFORM[platform];
  const value = override ?? env[binding];
  if (value === undefined || value === '') {
    if (isProduction) {
      throw new Error(
        `OTA bundle checksum misconfigured: ${binding} is unset in production, so no native ` +
          'client can install the published bundle. Re-run the OTA publish step so the binding ' +
          "carries the platform bundle's sha256."
      );
    }
    return undefined;
  }
  return value;
}

/**
 * The version `/updates/current` serves: the dev-only override wins so E2E can
 * drive a mismatch. A deployment with neither is a defect, not a degraded mode
 * — every client would be stranded on whatever it already runs.
 */
export function resolveServedVersion(
  override: string | null,
  appVersion: string | undefined
): string {
  const version = override ?? appVersion;
  if (version === undefined || version === '') {
    throw new Error('APP_VERSION is required to serve /updates/current');
  }
  return version;
}

export const downloadParamsSchema = z.object({
  platform: z.enum(MOBILE_PLATFORMS),
  version: z.string().min(1),
});

/** One object per platform+version — the layout the CI OTA publish step writes. */
export function bundleObjectKey(platform: string, version: string): string {
  return `builds/${platform}/${version}.zip`;
}
