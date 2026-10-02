# gitleaks licence

Obtain the organisation licence key the trusted-phase secret scan runs the vendor's Action under, and replace it with a key the vendor reissues. The Action checks only that a key is present: a missing one fails the job, an expired one changes nothing. Design: `docs/SECRETS.md`.

## Obtain

Vendor references: [gitleaks.io](https://gitleaks.io), and in the `gitleaks/gitleaks-action`
repository `README.md`, `LICENSE.txt` (the EULA), `src/index.js` and `src/keygen.js`.

1. On gitleaks.io select **Free Organization License Key** (the README's FAQ calls the control
   **Sign Up**). It opens a Google Form asking for a name, an email address and a company.
2. The key arrives by email "shortly after submission". No dashboard, account or portal shows a
   key again: the email is its only display. The value's shape is documented nowhere; treat it
   as an opaque string.
3. Write the offline copy (`docs/SECRETS.md` §Rules), then set `GITLEAKS_LICENSE` in the `ci`
   environment of both the public and the staging repository — the `gitleaks` job in
   `.github/workflows/ci.yml` runs in each. The Action reads it as the `GITLEAKS_LICENSE` key
   under the step's `env:`, never `with:`.

What the licence covers is the vendor's Action, not the scan. The EULA requires a key "to scan
repositories owned by an Organization Account" and none for a personal account; the `gitleaks`
binary underneath stays MIT-licensed and needs no key, which is why the pull-request phase runs
it directly through `scripts/gitleaks-scan.ts`. The key buys the Action's conveniences —
dispatchable scans, SARIF artifacts, job summaries, pull-request comments. When the vendor
validates keys, the fingerprint is the repository's `owner/name`, counted against a per-key
repository cap, so each repository the trusted phase runs in takes one slot. The EULA still
describes purchasable tiers with repository limits, fees and refunds, while the live site offers
only the free key; whether paid tiers are still sold could not be established, and the EULA's
contact clause is the only route named for asking.

The failure modes run opposite to what a reader assumes. They were read from the Action's source
(`src/index.js`, `src/keygen.js`); its documentation states neither:

- **Absent, on an organisation-owned repository:** the Action logs "missing gitleaks license"
  and exits 1 — the job fails closed. It also fails closed when its owner-type lookup errors,
  defaulting to requiring a key.
- **Present but expired or invalid:** not detected. The call that would validate the key
  against the vendor's licensing service is commented out in `src/index.js`, with an in-source
  note that the vendor's own payment method for that service was being declined; only the
  presence of a non-empty string is checked, so any non-empty value passes. The vendor presents
  this as a workaround, so it can change in any release without notice.

Probe: a push to `main` runs the trusted phase's **Scan for secrets** step to completion with the
key present; with it absent, the step fails with the message above. Nothing proves the key
valid while validation is disabled in the Action.

**The pin's own constraint.** The job pins `gitleaks/gitleaks-action` at a `v2.3.9` commit, a
Node 20 action. The vendor's README states that GitHub removes Node 20 from GitHub-hosted
runners on 2026-09-16 and that `gitleaks-action@v2` "will stop working regardless of any opt-out
flag" from then. The trusted-phase job runs on a Blacksmith runner, not a GitHub-hosted one, and
whether that image follows the same schedule was not established.

**Replace or revoke.** No self-service renewal or reissue exists: the EULA says a lapsed licence
requires "the purchase of a new license subscription" and names no portal, and whether reissue
means resubmitting the form or writing to the EULA's contact address is unresolved. A reissued
key is drop-in — set it in both `ci` environments. A leaked key grants a holder licensed use of
the Action against this key's repository cap, when validation runs; nothing in this repository
is exposed by it.
