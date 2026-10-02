# Backups

One encrypted repository on Backblaze B2 holds the Postgres dump and the three object
buckets together. `rustic` writes it in the restic repository format, so any
restic-family tool reads it and no single vendor holds the corpus. Read this when
touching the backup workflow, the retention values, the staleness auditor, or a restore.

The whole cycle is one entry point, `scripts/backup.ts`, run identically by
`.github/workflows/backup.yml` on its hourly schedule and by `pnpm backup` against a
local stack. Everything it needs is an env-registry entry, so the two runs differ only
in which stack's values load.

## What a run proves

A run dumps the database under one exported transaction snapshot, snapshots the source
buckets straight from object storage, and then proves what it wrote before it lets
anything go:

- **Reconciliation** — an independent listing of each source bucket, taken by the run
  itself, is compared against the snapshot just written. rustic decides what to re-read
  from a listing's sizes and modification times, so a listing it never saw is the only
  witness to a gap.
- **Spot restore** — one object per bucket is restored and hashed against the live
  object, both sides streamed, so neither is ever held whole.
- **Cryptographic read-back** — `check --read-data` over a rotating fraction of the
  repository, sized so a day of hourly runs re-reads every pack exactly once.
- **Restore drill** — the newest dump is restored into a throwaway Postgres and its
  table census compared, in both directions, against the census taken under the dump's
  own snapshot. Once a day, because it is the one step whose runtime grows with the
  database; a dispatched run always drills.

Retention runs last, so a run that found a gap leaves the previous good snapshots
reachable.

The scratch database and the dump hold every account's data in plaintext for as long as
the run lasts. The work directory and the drill's container are removed however the run
ends, and a removal that fails is itself a failure.

## The quarterly recovery drill

The workflow's restore drill is not the whole of the verification. Once a quarter the operator
restores the repository into a fresh database branch and a scratch object bucket and rebuilds from
it by hand. The per-run drill proves the newest dump restores into a throwaway database and
matches the census taken when it was dumped; it does not prove a person can bring the system back
from the repository, which is what a disaster asks. Procedure:
`docs/runbooks/infra/backup-viewer.md`.

## The retention ceiling

The privacy policy publishes a ceiling on how long a backup holds data after its
deletion (`packages/shared/src/legal/privacy-sections.ts`, the data-retention section).
Three values sum to that ceiling, and none may be changed on its own:

- **the forget ladder** — how far back the kept snapshots reach;
- **`prune --max-unused 0` with unlimited repack** — anything weaker leaves a deleted
  object with no bounded age at all, so the arithmetic refuses to state a number rather
  than stating a wrong one;
- **the backup bucket's lifecycle rule** — the writer key holds no destroy capability,
  so removing an object only hides a version, and this rule is the single stage of the
  chain that erases anything.

`retentionCeilingDays` in `scripts/lib/backup/run.ts` adds them, and a test asserts the
total stays inside the published bound — reading that bound out of the policy rather
than restating it, so neither side can move alone. Changing any of the three, or the
published promise, is one change.

## The staleness auditor

An hourly cron entry on the product Worker reads the repository through a list-only
credential and pages when the newest snapshot is older than its tolerance, or when the
bucket's lifecycle rule has drifted from the value the ceiling rests on. It detects and
never repairs: repair is finding out why the workflow stopped, or fixing the bucket's
configuration.

The tolerance is what fixes the cadence. It absorbs one missed run, so the auditor
cannot sit on a slower schedule than the backup itself without leaving a stopped backup
unreported for longer than the tolerance exists to allow.

## When the object listing outgrows the reconciler

The reconciler reads each snapshot's listing through a subprocess and parses it whole,
because a JSON document cannot be parsed in pieces. Past the largest string the runtime
can hold, the run fails with `the output passes the ceiling` rather than parsing a
truncated listing.

That failure is not a transient to re-run. It means the media bucket has passed roughly
two million objects, and the listing-based comparison has to be redesigned as a
streaming one. The module deliberately names neither the repository, the profile, the
key, nor its arguments in any error, so the message text is the entire diagnostic and
this section is the rest of it.

## Credentials and provisioning

Every value the run reads is an env-registry entry, inventoried in `docs/SECRETS.md`;
the B2 keys and the backup bucket's settings are
`docs/runbooks/secrets/backblaze-key.md`. Creating the repository is a one-time operator
act before the first scheduled run, never something the cycle does:
`docs/runbooks/infra/backup-repository.md`.
