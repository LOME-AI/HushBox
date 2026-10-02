# Backblaze B2 key

Four application keys on one Backblaze B2 account, never its master key, across two buckets. On the backup bucket: the **writer key** (`B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`) the backup run writes the encrypted repository with, the **auditor key** the Worker's staleness auditor lists it with, and the **operator key** an operator browses and restores it with. On the escrow bucket: the **escrow key** (`ESCROW_B2_KEY_ID`, `ESCROW_B2_APPLICATION_KEY`) the escrow workflow appends encrypted secret snapshots with — a key that uploads, lists bucket names, and reads nothing. This file also carries both buckets' creation settings, which nothing in code checks, and the restore drill that proves an escrow object can be opened. Design: `docs/SECRETS.md`; what the backup run does with the repository: `docs/BACKUPS.md`.

## Obtain

Backblaze runs two web consoles with different labels. The classic console reaches keys by the
left navigation, "B2 Cloud Storage" -> "Application Keys" -> "Add New Application Key"; the
Enterprise Web Console by "Access Control" -> "Application Keys" -> "Create App Key", and adds a
region selector that scopes the key to one region, so a key for a bucket is created in that
bucket's region. Which console an account shows cannot be established from Backblaze's
documentation; follow the labels you see. In both, "Allow Access to Bucket(s)" scopes the key to
one bucket, and the key's `applicationKey` is shown once, at creation — "for security, the
applicationKey appears only once"; the `keyID` stays visible on the keys page. Both consoles
offer only three access presets — "Read and Write", "Read Only", "Write Only" — and Backblaze
documents nowhere which capabilities each preset grants. Every key below is therefore created
with an explicit capability list through the B2 CLI, whose `key create` takes the capability
names as Backblaze spells them in its capabilities reference. The CLI must first be authorized
with a key holding `writeKeys`, on a trusted machine; the account's master key qualifies and is
used for nothing else. The master key is never S3-compatible, so no probe below runs with it.

### The backup bucket

Nothing in the backup run checks the bucket; this section is the check. Private
(`allPrivate`), file versioning on, no Object Lock, and one lifecycle rule:
`daysFromHidingToDeleting: 30`, matching `BACKUP_LIFECYCLE_NONCURRENT_DAYS` in
`packages/shared`.

That rule is not housekeeping. The writer key holds no destroy capability, so removing an
object only hides a version, and the rule is the single stage of the chain that erases
anything — it is a term of the retention ceiling the privacy policy publishes, and raising it
raises the worst-case age of deleted user data by the same number of days
(`docs/BACKUPS.md` §The retention ceiling). The Worker's auditor reads the rule back on every
hourly pass and pages when it drifts, so a value changed here without the constant is a page,
not a silent breach.

Object Lock is deliberately absent. The repository is rewritten by every prune, so a locked
version could never be reclaimed and the ceiling could not be met.

### The writer key

`B2_ACCOUNT_ID` is a key's `keyID` and `B2_ACCOUNT_KEY` its `applicationKey`, for a key scoped
to the backup bucket. It carries `listBuckets`, `listFiles`, `readFiles`, `writeFiles`, and
**not** `deleteFiles`. The backup run's prune removes old data, and `writeFiles` is enough:
without `deleteFiles` a removal hides a version rather than destroying it, and the bucket's
lifecycle rule expires what was hidden. Create it:

```
b2 key create --bucket <backup bucket> <key name> listBuckets,listFiles,readFiles,writeFiles
```

What a leaked writer key can do is bounded but not small: it can hide every version in the
bucket and overwrite every one, and the lifecycle rule then erases what it hid. It cannot
destroy a version outright. Recovery is that lifecycle window, and the staleness auditor is
what detects the hiding.

Write the offline copy of both halves, then set both in the `backup` environment; they are
coupled and are set together. Probe: the next hourly backup run.

### The auditor key

A second key scoped to the backup bucket, carrying exactly `listBuckets` and `listFiles`. The
Worker's staleness auditor issues two bucket-level GETs and never fetches an object body, so
`readFiles` would grant it nothing while turning a stolen key into a download of the whole
encrypted corpus at our egress expense. Create it:

```
b2 key create --bucket <backup bucket> <key name> listBuckets,listFiles
```

Write the offline copy of both halves, then set `BACKUP_B2_AUDITOR_KEY_ID` (the `keyID`) and
`BACKUP_B2_AUDITOR_KEY` in the `production` environment — the auditor runs on the product
Worker, not in the backup workflow. Probe: the auditor's next hourly pass raises no
`backup_audit_unavailable` capture.

### The operator key

A third key scoped to the backup bucket, carrying `listBuckets`, `listFiles` and `readFiles`.
Browsing snapshots and restoring from them is its whole purpose, so it needs the read the
auditor key is denied. Create it:

```
b2 key create --bucket <backup bucket> <key name> listBuckets,listFiles,readFiles
```

It reaches no GitHub environment and no registry entry: it is held only where an operator
browses the repository from. Write the offline copy of both halves.

### The escrow bucket

Nothing in the escrow job checks the bucket; this section is the check. Four settings, fixed
at creation: private (`allPrivate`), Object Lock enabled, a default retention rule in
compliance mode at the ceiling, and no legal hold.

**Enable Object Lock when you create the bucket.** Backblaze's own pages disagree on whether it
can be enabled on a bucket that already exists — the Object Lock overview, the existing-bucket
how-to and the Native API how-to say it can; two console summaries read as creation-only — and
every page agrees that once enabled it is never disabled. Creating the bucket with it enabled
makes the disagreement irrelevant. The creation dialog's exact Object Lock control is not
established in Backblaze's documentation; the S3 form is:

```
aws s3api create-bucket --bucket <escrow bucket> --object-lock-enabled-for-bucket --endpoint-url <endpoint>
```

Afterwards the bucket must read "Object Lock: Enabled" (classic console, on the bucket; the
Enterprise Web Console groups it under the bucket's Settings as "Lock Features"). Object Lock
cannot be enabled on a shared bucket or a replication source.

**Set the default retention rule: compliance mode, 3,000 days.** Object Lock alone protects
nothing — Backblaze's own warning is "you must set default bucket retention period before files
are immutable". The ceiling is Backblaze's: retention is "between one and 3,000 days". Classic
console: click "Object Lock: Enabled", enter the days, "Save changes" — whether that dialog
exposes the mode is not established, so confirm the mode through the API form, which is:

```
b2_update_bucket with "defaultRetention": { "mode": "compliance", "period": { "duration": 3000, "unit": "days" } }
```

Read the rule back before creating the key. Every object uploaded inherits it. A version under
compliance retention "cannot be removed by any user"; its retention date can be extended, never
shortened. Backblaze's help centre adds that this includes the account's own root user and that
Backblaze Support cannot lift it — that page refused every fetch during research, so treat those
two clauses as secondhand. Backblaze's stated remedy for a lock set longer than intended is
closing the account, so nothing short of account closure removes an escrow object during its
term. What non-payment does to locked data is likewise unestablished (the help-centre article on
non-payment was unreachable): keep the account paid, and read that article before relying on any
behaviour there. The account holds the only path to destroying an escrow, so it sits with the
accounts `docs/SECRETS.md` lists as held in no store: hardware-key MFA with no weaker fallback,
recovery codes offline.

**Leave legal hold unused.** A hold is lifted by any key holding `writeFileLegalHolds`, and
Backblaze documents no irreversible variant of it, so it adds nothing a leaked key could not
undo; the escrow key holds no hold capability and no hold is set.

**What a leaked escrow key can do to the bucket:** `writeFiles` covers `b2_hide_file` and an S3
`DELETE` by name — "writeFiles is needed when you delete a file by name, and deleteFiles is
required when deleting a specific version" — so the key can make an object vanish from a listing
of current names. It cannot destroy a version: only `deleteFiles` covers
`b2_delete_file_version`, and the key has none. The hidden version stays, listed by
`b2_list_file_versions` and never by `b2_list_file_names`. That is why the restore drill lists
versions.

### The escrow key

A key scoped to the escrow bucket carrying exactly `writeFiles` and `listAllBucketNames`: it
uploads, it can confirm the bucket exists (`listAllBucketNames` returns bucket names, not
contents), and it reads nothing — `readFiles` is what gates every download from a private
bucket. Never the "Write Only" preset, whose contents, and in particular whether it includes
`deleteFiles`, Backblaze documents nowhere. Create it:

```
b2 key create --bucket <escrow bucket> <key name> writeFiles,listAllBucketNames
```

Read the granted capabilities back before trusting the key: the `b2_authorize_account` response
carries the granted set (the field's name was not confirmed against the API reference during
research; check it there).

Write the offline copy of both halves. Set `ESCROW_B2_KEY_ID` (the `keyID`) and
`ESCROW_B2_APPLICATION_KEY` as repository-level secrets, and `ESCROW_B2_BUCKET` (the bucket
name) and `ESCROW_B2_S3_ENDPOINT` (the bucket's S3 endpoint, of the form
`https://s3.<region>.backblazeb2.com`, shown on the Buckets page under a label the research did
not confirm) as repository-level secrets. Repository level and not `production`, because the
escrow workflow runs one job per GitHub environment and every one of them writes to this same
bucket; an environment-held value is unreadable from any other. None of the four values appears
in the repository, so the repository names no location.

Probe: dispatch `escrow-secrets.yml`, choosing an environment on the form — the workflow writes
one environment's set per run. A green run is the only success the upload accepts — a
2xx from the bucket on one attempt. Then, with the same pair over the S3 endpoint, a download of
the object it wrote (`aws s3 cp s3://<escrow bucket>/escrow/<object> ./out --endpoint-url
<endpoint>`) must be refused. That refusal proves the key cannot read, not which capability is
absent: Backblaze answers a bucket-restricted key with an opaque 403 in more than one case.

## Restore drill

Run it after the first escrow run, and after any change to the recipients, the bucket, or the
key. The escrow key cannot run it — listing objects and downloading need `listFiles` and
`readFiles`. Use the console signed in as the account, or a key scoped to the escrow bucket
holding `listFiles` and `readFiles`, created for the drill and deleted afterwards.

1. List object versions, never current names: `aws s3api list-object-versions --bucket <escrow
bucket> --prefix escrow/ --endpoint-url <endpoint>` (S3 form, not run by this repository), or
   the Native API `b2_list_file_versions`. A names listing omits anything a leaked write key hid;
   the versions listing shows every upload, with a hide marker beside any that was hidden.
   The `production` set is named `escrow/<run id>-<commit sha>.json.age`; every other
   environment's set takes a prefix of its own, `escrow/<environment>/<run id>-<commit
   sha>.json.age`. One name per escrow run, but not always one version. The job makes a single
   upload attempt and never retries, yet a
   GitHub Actions re-run of a failed job keeps the run id (GitHub's documented behaviour: a
   re-run increments `run_attempt`, not `run_id`), so it addresses the same name again, and an
   object-locked bucket — versioned by requirement — accepts that write as a further version
   under the name while the earlier one stays under its retention (Backblaze's and AWS's Object
   Lock documentation; nothing in this repository writes twice to a locked bucket). Two versions
   under one name with no hide marker are what a re-run leaves, not by themselves tampering or
   corruption; the fingerprint cross-check judges a document, never the version count. Take the
   latest version: a failing attempt stops before the upload or on the store's refusal of it, so
   every version under a name is one attempt's complete document, and the latest is the last
   attempt's.
2. Download the latest version of the object for the run under test.
3. `age -d -i <identity> <file>` with either identity file. The plaintext is one JSON document
   `{ runId, commitSha, secrets, fingerprints }`.
4. Read it: `commitSha` is the deploy's commit, and `secrets` holds every name the inventory in
   `docs/SECRETS.md` marks `Escrowed`, and no other.
5. Cross-check the fingerprints against the database, with a role permitted to select these
   columns (the admin panel role is denied them by design): `fingerprints.OPAQUE_KEK` equals the
   hex of `users.opaque_kek_fingerprint` on any row, and `fingerprints.TOTP_ENCRYPTION_SECRET`
   equals the hex of the leading bytes of `users.totp_secret_encrypted`, as many bytes as the
   fingerprint has, on any row with a second factor enrolled. A mismatch means the escrowed
   value is not the key those rows are sealed under — a stale escrow or a poisoned one — and
   nothing is restored from it.

## Replace

Either B2 key is drop-in: create the successor with the same scope and capability list, write
its offline copy, set both halves of the pair together, then delete the old key — "You cannot
restore the app key", so the offline copy is the only way back to a deleted one. Neither
replacement touches an escrow object.

An age identity is replaced in `scripts/lib/escrow/recipients.ts`: generate the new identity on
a trusted machine (`age-keygen -o <file>`), swap its `age1…` public string in through a reviewed
diff, and keep the two identity files in two physical places. Losing one identity costs nothing
while the other exists. A leaked identity opens every object already in the bucket, and
compliance retention keeps those objects for their full term, so a leak is a rotation of every
escrowed secret — each by its own runbook — and that cost is the design's intended one.
