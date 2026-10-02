# Stryker dashboard key

Obtain the per-repository API key the Stryker dashboard issues for publishing mutation reports, and replace it by re-enabling the repository on the dashboard, which mints a successor and kills the old key at once. The reporter that reads it never fails a build, and it is not among the reporters `stryker.config.json` names. Design: `docs/SECRETS.md`.

## Obtain

Vendor references: [Stryker Dashboard](https://stryker-mutator.io/docs/General/dashboard/), and
the `stryker-mutator/stryker-dashboard` repository, whose interface copy and backend controllers
are the only statement of the key's scope and rotation.

1. Open [dashboard.stryker-mutator.io](https://dashboard.stryker-mutator.io) and select **Sign in
   through Github**. The dashboard authenticates by GitHub OAuth only; the list that follows
   shows your public repositories under **Enabled repositories** and **Disabled repositories**,
   each row a toggle.
2. Toggle the public repository on. A modal titled **Configuring <repository>** opens with an
   **API Key** section reading "Here's your API key:" and, in the dashboard's words, "This is
   the last time we'll be showing it to you (although you can create new ones at any time)."
   Copy it from that modal; the dashboard stores only its hash.
3. The key is per repository, not per account: it authenticates only requests whose URL names
   that repository's slug (`github.com/<owner>/<repository>`; "the dashboard backend only
   supports github.com"). A holder can `PUT` a report for any version of that project —
   replacing whatever the version holds, a fabricated score behind the public badge included —
   and `DELETE` its reports. Reading needs no key: the report routes are public to everyone.
4. Write the offline copy (`docs/SECRETS.md` §Rules), then set `STRYKER_DASHBOARD_API_KEY` in
   the `ci` GitHub environment of the public repository; the mutation workflow
   (`.github/workflows/mutation.yml`) runs only there and passes it to `pnpm mutation`.

Stryker's `dashboard` reporter is the only reader of the key, and it runs only when
`reporters` names it and `dashboard.project` is set. While `stryker.config.json` names other
reporters, the workflow sets the key and no code reads it. When the reporter does run, a
missing or wrong key never fails the build: the upload gets a 401, the client throws
"Unauthorized. Did you provide the correct api key in the "STRYKER_DASHBOARD_API_KEY"
environment variable?", and the reporter catches that and logs "Could not upload report." —
the exit code is what it would be with no dashboard reporter at all. Only a reader of the job
log sees it. Established from `@stryker-mutator/core`'s reporter source; the vendor's
documentation says nothing about it.

Probe, against a version name no branch or tag uses, so no real report is touched:

```
curl -X PUT https://dashboard.stryker-mutator.io/api/reports/github.com/<owner>/<repository>/probe \
  -H 'Content-Type: application/json' -H 'X-Api-Key: <key>' -d '{"mutationScore": 0}'
curl -X DELETE https://dashboard.stryker-mutator.io/api/reports/github.com/<owner>/<repository>/probe \
  -H 'X-Api-Key: <key>'
```

A live key succeeds on both; a wrong one answers 401. A `PUT` to an existing version's URL
replaces that version's report with no confirmation, which is why the probe names its own.

**Replace or revoke.** The dashboard documents no rotation; its own controller and interface
copy supply one. Every enable of a repository mints a fresh key and overwrites the single stored
hash — the modal, reopened, says "If you need a new one, re-enable this repository." — so
rotation is: toggle the repository off, toggle it on, copy the key from the modal, set the
secret. The old key stops authenticating the moment the toggle completes; there is no grace
window. A scheduled run landing between the toggle and the secret update logs the upload error
above and exits green, so the cost is one unpublished report. Under compromise, toggle first —
the leaked key dies with the toggle — and set the successor after.
