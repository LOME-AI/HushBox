# Backup repository

Create the encrypted repository the hourly backup cycle writes into, and prove it. Its
credentials and the backup bucket's settings are
`docs/runbooks/secrets/backblaze-key.md`; what the cycle does with the repository is
`docs/BACKUPS.md`.

## Provision

Once, after the bucket exists and its keys are minted, and before the first scheduled
run. The cycle never creates a repository: a run that finds none refuses and names the
address it found nothing at.

1. Dispatch `.github/workflows/backup.yml` with its `provision` input set. It creates
   the repository, backs nothing up, and refuses a repository that already exists. A
   dispatch rather than a local command because the credentials stay in the environment
   that already holds them; provisioning from a laptop would put production credentials
   on a personal machine. Against a local stack the same act is `pnpm backup --provision`.
2. Dispatch the workflow again with the `provision` input clear. A dispatched cycle
   always restores the newest dump and proves it, where a scheduled run drills once a
   day, so one green dispatch proves the whole chain: the snapshots exist, the
   repository reads back, and the database restores.

Two provisioning runs against an empty bucket would each write a master key of their
own, and every command afterwards — theirs and the cycle's — would be refused by the key
that lost, leaving the corpus unreadable rather than merely incomplete. The workflow's
concurrency group is what makes two of them impossible; step 1 is the instruction, not
the guard.
