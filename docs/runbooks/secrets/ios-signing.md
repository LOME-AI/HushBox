# iOS signing

Obtain the App Store Connect API key and the fastlane match store password and git credential, and replace each: the two vendor-issued values are drop-in, and the store password's replacement re-encrypts the certificate store in place. Design: `docs/SECRETS.md`.

## Obtain

Every value below is set in the `production` GitHub environment, where the iOS build workflow
reads it. The three identifiers beside them — `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `MATCH_GIT_URL`,
the HTTPS clone URL of the private repository holding the encrypted certificates — are held
there too, and the probe at the end of this section proves the whole set at once.

### The App Store Connect API key

`ASC_KEY_CONTENT` is a Team key, never an Individual key: Apple's page states Individual keys
"aren't able to use Provisioning endpoints", which is what certificate and profile management
is, and generating a Team key requires an Admin account. In App Store Connect: "Users and
Access" -> the "Integrations" tab -> "App Store Connect API" in the left column -> the "Team
Keys" tab -> "Generate API Key" (or the "+" button). Enter a name, and under "Access" select
"Admin". Admin is inferred as the minimum, not read from Apple's capability matrix, whose cells
could not be retrieved during research: Apple's role reference names Certificates, Identifiers
& Profiles access under Admin alone, no page names a lower role for the Provisioning endpoints,
and no page states the role a build upload needs. Click "Generate", then "Download API Key" on
the new row — the `.p8` downloads a single time, the link disappears afterwards, and Apple keeps
no copy. Write the offline copy from that file. The Fastfile reads the value as base64, so the
secret is the file's one-line encoding:

```
base64 -w0 AuthKey_<key id>.p8
```

(`base64 -i AuthKey_<key id>.p8` on macOS.) `ASC_KEY_ID` is the key ID shown on the row and in
the file name. `ASC_ISSUER_ID` is one value for the whole team; third-party integration guides
place it above the Team Keys table on the same screen, and Apple's own page does not mention
it — confirm where it appears.

### The match store password

`MATCH_PASSWORD` is chosen by the operator, not issued: match asks for it at the first
write-mode run, which creates the distribution certificate and the App Store provisioning
profile for `ai.hushbox.app` and pushes them, encrypted under it, to the certificates
repository. CI's `match` runs read-only — it never contacts the Developer Portal, never writes
to the repository, and against an empty store fails rather than creates — so that write-mode
run must precede the first CI build. Choose the passphrase and write its offline copy first.
Then, on a Mac with this repository cloned, `MATCH_GIT_URL` set, and push access to the
certificates repository under your own git credentials, from `apps/web/ios`:

```
bundle install
bundle exec fastlane match appstore
```

The run authenticates to the Developer Portal (an Apple ID prompt, or the App Store Connect key
above), then — with no `MATCH_PASSWORD` in the environment and no match entry in the login
Keychain — asks "Passphrase for Match storage:" with a confirmation. Type the chosen value;
match also stores it in that machine's login Keychain, under a `match_`-prefixed entry.

### The git credential

`MATCH_GIT_BASIC_AUTHORIZATION` is the base64 of `<github username>:<token>` — HTTP Basic
framing — for a fine-grained personal access token that reads the certificates repository and
nothing else. On GitHub, as the account that will own the token: profile picture -> "Settings"
-> "Developer settings" -> "Personal access tokens" -> "Fine-grained tokens" -> "Generate new
token". "Resource owner": the account or organization that owns the certificates repository.
"Expiration": choose one and calendar its replacement; GitHub also removes a token unused for a
year. "Repository access": "Only select repositories", then that repository alone. "Repository
permissions": "Contents" set to "Read-only" — GitHub adds "Metadata: Read-only" itself. Click
"Generate token"; the token is shown once. If the owner is an organization that requires token
approval, the token stays pending, and `match` cannot clone, until an organization owner
approves it. Encode:

```
printf '%s' '<github username>:<token>' | base64 -w0
```

Write the offline copy of the encoded value, then set it. One caution, reported against
fastlane and not confirmed against its source during research: when the clone fails, `match`
may print the git command with this header in clear. After a build that failed at the clone,
treat the token as exposed and replace it.

### Setting and probing

Set the three secrets and the three identifiers in `production`. Probe: dispatch the Release
workflow with platform `apple_store`. Track `manual` builds and signs an IPA and attaches it as
a workflow artifact, which proves the store password and the git credential; the read-only
`match` never calls Apple, so the API key is exercised only by an upload — track `internal`
builds, signs, and uploads the build to TestFlight, proving all three.

## Replace

`MATCH_PASSWORD` is the operator-procedure class, because a replacement re-encrypts the
certificate store in place and the old and new values never overlap. `fastlane match
change_password` — git storage only, which the Matchfile declares, and interactive only —
clones the certificates repository, decrypts every file under the current passphrase, asks for
the new one, re-encrypts every file under it, and records the result as a commit titled
`[fastlane] Changed passphrase`. No certificate or profile is reissued, and nothing installed on
a device changes.

Run it on a clean Mac: no `MATCH_PASSWORD` in the environment and no match entry in the login
Keychain, so the current passphrase is what you type from the offline copy rather than stale
local state — a `MATCH_PASSWORD` left in the environment is what a reported fastlane issue
blamed for re-encrypting the store under the old passphrase. The machine holds this repository
cloned, `MATCH_GIT_URL` set, and push access to the certificates repository under your own git
credentials. Write the new passphrase's offline copy first, then from `apps/web/ios`:

```
bundle install
bundle exec fastlane match change_password
```

Confirm the `[fastlane] Changed passphrase` commit is on the certificates repository's remote,
then set `MATCH_PASSWORD` in `production` at once. From that commit until the secret is updated,
every iOS build fails at CI's read-only `match` step; a build already past that step finishes
normally. Re-run any Release run that failed in between, then run the probe. After any change
to `MATCH_PASSWORD` — this procedure or the regenerations below — dispatch the escrow workflow
(`.github/workflows/escrow-secrets.yml`, `workflow_dispatch`, `production` environment;
`docs/runbooks/secrets/backblaze-key.md`): the passphrase is escrowed, but the escrow job runs on its
own only in a deploy's run, and a signing change causes no deploy, so without the dispatch the
escrow holds the old passphrase for as long as nothing else lands on `main`.

**When the passphrase is lost.** Nothing decrypts the store without it, and `match nuke` needs
it too. The Mac that ran the first write-mode `match` may still hold it in its login Keychain,
under the `match_`-prefixed entry; recover it there and run the replacement above. Otherwise
the store is regenerated: empty the certificates repository by hand, choose and copy a new
passphrase, and run the write-mode `match appstore` from §Obtain, which issues a fresh
distribution certificate and profile; then set the secret and run the probe. A leaked
passphrase is regenerated the same way, and the abandoned certificate is then revoked in
Certificates, Identifiers & Profiles. What revocation does to shipped builds is sourced only
from Apple Developer Forums threads, not an Apple support article: apps on the App Store
continue, because Apple re-signs what it distributes; TestFlight builds signed under the
certificate may stop installing, and Apple's own portal warning says related profiles "may be
affected"; Enterprise distribution, which this app does not use, breaks on installed devices.
Ship a fresh TestFlight build directly after revoking.

**`ASC_KEY_CONTENT` and `MATCH_GIT_BASIC_AUTHORIZATION`** are drop-in: create the successor by
§Obtain, set it, then revoke the old one. Apple's revocation page could not be read during
research; by the creation screen's pattern the key's row under "Team Keys" carries the revoke
action, and Apple's guidance is to revoke immediately on suspected compromise. The GitHub token
is deleted from the "Fine-grained tokens" list.
