# GitHub App private key

Obtain `HUSHBOX_SYNC_PRIVATE_KEY`, the private key of the sync GitHub App that alone writes public `main` — the push that is the production deploy trigger — and replace it with no gap, by generating the successor while the old key still signs. Design: `docs/SECRETS.md`; the topology the App serves: `docs/PUBLICATION.md`.

## Obtain

Every claim about GitHub's interface below was read from GitHub's own documentation during
research; where that documentation stops, the text says so.

### Register the App

Register it under an organisation, never under one person's account. The App is the only
writer of public `main`, so its owner is the account whose loss, compromise or departure
stalls every deploy; an organisation-owned App survives a personnel change because several
people can hold organisation owner or "GitHub App manager" roles over the one registration
(a manager edits the App's settings but cannot install it — installing stays with
organisation owners). Whether an App can move from personal to organisation ownership after
registration appears on no GitHub page read during research, so the choice is made at
registration. Profile picture -> "Your organizations" -> "Settings" beside the organisation
-> "Developer settings" -> "GitHub Apps" -> "New GitHub App" (for a personal account:
profile picture -> "Settings" -> "Developer settings" -> "GitHub Apps" -> "New GitHub App").
The name must be unique across GitHub, at most 34 characters.

Under "Repository permissions", set:

- "Contents": "Read and write" — the Git Data endpoints a push uses. The App pushes both
  repositories: the mirror pushes public `main`, and the inbound sync pushes the merge onto
  staging `main`.
- "Metadata": "Read-only" — every App requires it, and GitHub's page states it is set by
  default; that choosing another repository permission forces it back to "Read-only" is a
  third-party walkthrough's description.
- "Workflows": "Read and write" — GitHub refuses a Contents-only push that changes a file
  under `.github/workflows/`, and the mirror publishes staging commits whole, workflow files
  included, so without it the first publication carrying a workflow change is refused.

The App's remaining calls sit outside the push set research mapped to permission names: the
auditor lists, files and closes issues on staging, lists a workflow's runs there, and the
mirror and the green borrow read staging's `ci.yml` push runs and their jobs under a token
narrowed to Actions read on staging (`scripts/lib/publication/api.ts`). Grant what GitHub's
"Permissions required for GitHub Apps" reference names for those endpoints — expected to be
"Issues": "Read and write" and "Actions": "Read-only", which research did not confirm against
that reference. A refusal from any endpoint names the
permission it wanted in the `X-Accepted-GitHub-Permissions` response header. Everything else
stays "No access"; the App needs no organisation or account permission.

### Generate the private key

"GitHub Apps" -> "Edit" beside the App -> under "Private keys", "Generate a private key". A
PEM file downloads, in PKCS#1 `RSAPrivateKey` format, and "GitHub only stores the public
portion of the key": there is no re-download, and a key whose file is lost is deleted and
regenerated. Write the offline copy from that file before anything else (`docs/SECRETS.md`
§Rules). Beside each key GitHub shows a SHA-256 fingerprint; the file in hand is that key
when this prints the same value:

```sh
openssl rsa -in <pem file> -pubout -outform DER | openssl sha256 -binary | openssl base64
```

`HUSHBOX_SYNC_APP_ID`, stored beside the key, is the App ID the App's settings page shows;
the sync code signs its JWT with the App ID as issuer (GitHub accepts the App ID or the
client ID there). It is an identifier, not a credential.

### Install the App on both repositories

"GitHub Apps" -> "Edit" beside the App -> "Install App" -> "Install" beside the account that
owns the repositories -> "Only select repositories" -> in "Select repositories" pick the
public repository and the staging repository -> "Install". Both, because the App pushes to
both and audits from staging. "Only select repositories" bounds the granted permissions to
those two; every App keeps read access to every public repository on GitHub regardless.
Organisation owners install; a manager cannot.

The ruleset on public `main` admits updates from the sync App alone (`docs/PUBLICATION.md`
§Topology). A newly registered App is added there as the bypass actor, or the ruleset
refuses its first push whatever the App's permissions. That ruleset's screen was not
researched here.

### Set and probe

Set `HUSHBOX_SYNC_PRIVATE_KEY` (the PEM file's contents, newlines and all) and
`HUSHBOX_SYNC_APP_ID` as repository-level Actions secrets — outside any environment — in
both the staging and the public repository: the mirror and the auditor read them in staging;
the inbound sync, the merge-queue alignment check and the green borrow read them in public. A
missing or refused public copy turns nothing red: every public push then runs its checks in
full (`docs/PUBLICATION.md` §Green borrowing).

At runtime the sync code (`scripts/lib/publication/github-app-token.ts`) signs a short-lived
RS256 JWT with the key, asks `GET /repos/{owner}/{repo}/installation` for the installation's
id, and mints a one-hour installation access token from
`POST /app/installations/{id}/access_tokens`; that token is what pushes, as `x-access-token`
over HTTPS, and what the REST reads carry. A refusal names the step ("the installation
lookup", "the token mint") and withholds the body.

Probe: in the staging repository, dispatch `sync-auditor.yml`. It is read-only by
construction and exercises the whole chain — the JWT, the installation lookup on staging,
the token mint, a fetch of public over that token, and the issue listing — and a green run
with no finding is the proof. It does not push; the next mirror run does (its schedule is
pinned, and a dispatch publishes at once and discloses the moment — the trade
`docs/PUBLICATION.md` records), and the auditor's next pass confirms the mirror ran.

## Replace

An App holds up to 25 private keys at once, each signing independently, and holding several
for zero-downtime rotation is GitHub's documented model: "private keys do not expire and
instead need to be manually revoked". The replacement therefore has no gap, in this order:

1. Generate a second key (§Obtain) and write its offline copy; the old key still signs.
2. Set `HUSHBOX_SYNC_PRIVATE_KEY` to the new PEM in both repositories.
3. Run the probe, then wait for a green mirror run on the new key. The probe exercises only
   the staging copy; a public push that skips its check jobs proves the public copy.
4. Delete the old key, matched by fingerprint: "GitHub Apps" -> "Edit" -> "Private keys" ->
   "Delete" beside it -> confirm. Deletion is the revocation; there is no separate revoke.

Two facts an operator might reach for here are held at a lower grade than the rest of this
file. That deleting one key leaves the App's installations and its other key untouched is
reasoned from GitHub's rotation model, stated on no page read; the order above is why it
never has to be relied on. And whether generating or deleting a key writes an audit-log
entry is answered only by one unanswered community report, which says it does not; expect no
log line.

On a leak, invert the order: delete the leaked key first, then generate and set the
successor. A stalled mirror costs one delayed publication and an auditor issue; a hostile
push to public `main` is a production deploy. Installation tokens already minted from the
leaked key live out their hour — deletion does not cut them short.
