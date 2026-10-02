# Values minted per deploy

Values the deploy job mints itself: the served application version and the checksum of each mobile over-the-air bundle. There is nothing to obtain and nothing to copy; the next deploy replaces them. Design: `docs/SECRETS.md`.

## Obtain

Nothing. No GitHub secret backs these, no human ever holds one, and there is no offline copy
or escrow entry to look for. Each is computed in `.github/workflows/ci.yml`. A member
destined for the Worker is published with the real secrets; a member destined for a
client bundle is baked in at build time and reaches no Worker. The members are this
family's entries in the `docs/SECRETS.md` inventory:

- `APP_VERSION` — `scripts/compute-next-version.ts`, run in the `version-claim` job on the
  push that deploys: the highest release tag or version claim bumped by the merged pull
  request's `major` or `minor` label (patch when neither is present), `1.0.0` when no tag
  or claim exists (`docs/BUILD-AND-CI.md` §The production deploy). Bare semver, no `v`.
- `VITE_APP_VERSION` — the same version, baked into the client bundles.
- `VITE_PRIVACY_POLICY_EFFECTIVE_DATE`, `VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE` —
  `scripts/legal-effective-dates.ts`, run in the `version` job: the day of the earliest
  release tag whose commit already declared the document's current revision, today when
  none has; baked into the client bundles.
- `APP_BUNDLE_CHECKSUM_IOS`, `APP_BUNDLE_CHECKSUM_ANDROID`,
  `APP_BUNDLE_CHECKSUM_ANDROID_DIRECT` — the SHA-256 (`sha256sum`) of each platform's zipped
  `dist-<platform>` bundle, taken in the step that uploads the over-the-air bundles to R2.

A wrong value is a wrong deploy, and the only fix is another deploy. To check what
production serves, read the version and checksums the updates slice publishes rather than
any secret store.
