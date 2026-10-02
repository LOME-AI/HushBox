# Backup viewer

Browse the encrypted backup repository, restore from it, prove what it holds, and run the
quarterly recovery drill. Backrest — a web front end over the restic command line — runs as a
container on the operator's own Unraid server and opens the same repository the hourly backup
workflow writes. What the repository holds and what each run already proves: `docs/BACKUPS.md`.

This instance holds the repository password and a key that reads the whole corpus. Together they
are every backup in clear, the database dump included, so the machine and the port it listens on
are as sensitive as a copy of the database.

## What keeps it from writing

The Backblaze key minted for this viewer carries `listBuckets`, `listFiles` and `readFiles` and no
write or delete capability (`docs/runbooks/secrets/backblaze-key.md`), so Backblaze refuses any
write whatever this instance is configured to attempt. That grant is the enforcement. Backrest is
a full backup tool with no read-only mode: its repository-level Prune, Forget and Check policies
each write, and a prune driven from here would also race the hourly run. Leaving those schedules
unset, below, is what keeps the instance from attempting hourly writes it cannot complete — it is
not what protects the repository.

## Stand it up

1. Install from Unraid's **Community Applications** under the template name `backrest`. The
   template is community-maintained rather than published by Backrest's author, and it names the
   image's `latest` tag: change it to a released version tag, so an upgrade is something you
   choose.
2. Keep the template's required mounts — `/config`, `/cache` and `/data` — at its host paths. Its
   optional `/repos` and `/backup` mounts are for repositories on this machine; this one is
   remote, so leave them out.
3. Keep the environment the template sets: `BACKREST_DATA=/data`,
   `BACKREST_CONFIG=/config/config.json`, `XDG_CACHE_HOME=/cache`.
4. Publish port 9898 to the local network only and never forward it from the internet. In a
   container Backrest listens on every interface, where the bare program listens on loopback
   alone, so where you publish the port is the whole of what limits reach to it.

## Register the repository

Neither the name nor the URI can be changed after the repository is added, so a mistake in either
is a delete and re-add. In **Add Repo**:

1. **URI** — `s3:https://s3.<region>.backblazeb2.com/<bucket>/<prefix>`, spelled from three values
   the backup workflow already binds: `BACKUP_B2_S3_ENDPOINT` (its region is the one on the
   bucket's card at Backblaze), `BACKUP_B2_BUCKET` and `BACKUP_REPO_ROOT`.
2. **Password** — the value held as `BACKUP_REPOSITORY_PASSWORD`
   (`docs/runbooks/secrets/random-secret.md`). Nothing here reads the repository without it and
   nothing here recovers it.
3. **Environment variables** — `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, holding the
   operator key's pair, under exactly those names: an `s3:` URI selects restic's S3 backend, which
   reads no other names, and the native Backblaze backend's names are not it.
4. **Flags** — add `--no-lock`. A restic operation that locks the repository does it by writing an
   object, which this key cannot; the flag keeps browsing and restoring from failing on a write
   they do not need.
5. **Prune**, **Forget** and **Check** — leave every schedule unset.
6. Save, then **Index Snapshots**. The import is right when the snapshot list shows the four
   labels the workflow writes — `media`, `app-builds`, `model-weights` and `postgres` — under the
   host `hushbox-backup`.

## Prove the data

- Browse the newest snapshot of a label and read its file list against what that bucket holds.
- Restore one object and compare it with the live one: the restored bytes' MD5 against the
  object's ETag in R2. Choose an object small enough to have been stored in one part — a
  multipart upload's ETag ends in `-<n>` and is not the object's MD5.
- Run **Check** with a read-data percentage when you want the stored bytes themselves read rather
  than the index. Every hourly run already reads a rotating share of the repository
  (`docs/BACKUPS.md`).
- Read the repository's logical and stored totals in the repo view. The gap between them is
  deduplication and compression; every run reports the same two totals, and reading them here
  proves them from the repository rather than from a workflow log.

## The quarterly recovery drill

Once a quarter, restore the system from the repository by hand. This is the drill the workflow
cannot run for you: its own restore drill proves the newest dump restores into a throwaway
database and matches, and stops there.

1. Restore the newest `postgres` snapshot and the newest snapshot of each object label.
2. Load the dump into a fresh Neon branch, never the production branch.
3. Upload the restored objects into a scratch bucket, never a production one.
4. Check what you restored: the branch's applied-migration head and per-table row counts match
   production's, and a sample of restored objects matches its live counterpart.
5. Delete the branch and the scratch bucket. The restored dump is every account's data in clear,
   and the scratch bucket is a second copy of the corpus sitting outside the retention ceiling the
   privacy policy publishes (`docs/BACKUPS.md`).
