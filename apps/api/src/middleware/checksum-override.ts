/**
 * Module-level per-platform OTA bundle checksum override for the local mobile
 * update harness.
 *
 * Same dev-only shape and justification as `apps/api/src/middleware/version-override.ts`:
 * the only setter is `POST /dev/set-checksum`, a `dev-only`-class route that
 * answers 404 in production, so a production request always resolves the
 * deploy-published binding and the override can never influence it.
 *
 * It exists because no binding can stand in for it locally: a bundle's sha256
 * does not exist until the zip is built, so env generation has no value to
 * carry and the harness would otherwise serve no checksum at all — which the
 * native client refuses to install. Keyed per platform because each platform's
 * bundle is a distinct build with a distinct hash, exactly like the three
 * deploy bindings it stands in for.
 *
 * Lives in `middleware/` beside `version-override.ts`, the dev channel it
 * mirrors and is set alongside.
 */
const checksumOverrides = new Map<string, string>();

export function getChecksumOverride(platform: string | undefined): string | undefined {
  return platform === undefined ? undefined : checksumOverrides.get(platform);
}

export function setChecksumOverride(platform: string, checksum: string): void {
  checksumOverrides.set(platform, checksum);
}

export function clearChecksumOverrides(): void {
  checksumOverrides.clear();
}
