# Linear API keys

Obtain `LINEAR_API_KEY_READ`, the key the public roadmap page reads the workspace with, and `LINEAR_API_KEY_WRITE`, the key the board-grooming workflow reads and writes it with, and replace either by creating its successor before revoking it. Both are personal keys: each lives and dies with the Linear account that created it. Design: `docs/SECRETS.md`.

## Obtain

Linear issues one kind of API key, the personal API key, created under an individual's own
account settings and ceilinged by that person's own workspace access. **A production page
therefore depends on one person's account standing.** Linear's own FAQ: "What happens to API
tokens when a user is suspended or converted to a guest? The API tokens will be revoked and
invalidated." Suspension is Linear's only removal verb ("Suspend user..." under "Settings" >
"Administration" > "Members"), so offboarding, or demoting to guest, the person who created
a key revokes it in the same act. If that happens to the read key: Linear refuses the
roadmap fetch, the API answers `GET /public/roadmap` with 503 `SERVICE_UNAVAILABLE`, the
edge serves the last good board for up to a day under the route's `stale-if-error`
(`docs/CACHING.md`; a deploy in between empties that cache), and after that the marketing
site's roadmap page shows "The roadmap is temporarily unavailable. Please try again
shortly." The trusted CI test job goes red at its real Linear call. If it happens to the
write key, the grooming workflow fails in its preflight job at "Back up the board".

Who creates a key decides whether the path exists: "Admins and permitted Members can create
personal API keys" — a Member only while "Settings" > "Administration" > "API" > "Member API
keys" allows it, a setting that never applies to Admins.

Signed in as the account that will own the key: "Settings" > "Account" > "Security & Access"

> "Personal API keys". The creation dialog's layout is described on no Linear page (a label
> field and a create button are all third-party guides mention), but Linear's own text names
> what it offers: full access to everything your user can access, or a restriction to some of
> "Read", "Write", "Admin", "Create issues", "Create comments"; and optionally a limit to
> specific teams. Limit both keys to the HushBox team, key `HUS` (`LINEAR_TEAM_KEY` in
> `packages/shared`): the roadmap queries that team alone, and the board tool filters and
> creates within it. Permissions:

- `LINEAR_API_KEY_READ`: "Read" only. Nothing about the roadmap writes.
- `LINEAR_API_KEY_WRITE`: "Read" and "Write". The board tool updates and creates issues,
  creates comments and creates projects (`scripts/linear/board.ts`; it has no delete
  command). Whether "Write" covers all four, or "Create issues" and "Create comments" must
  be added beside it, Linear does not document; a live grooming run refused at one of them
  is the signal to widen.

The value: third-party sources report it beginning `lin_api_`, and that it is shown once;
Linear's own pages print no example and never say whether a key can be viewed again. Treat
it as shown once — write the offline copy from the creation screen (`docs/SECRETS.md`
§Rules) before closing it. It is sent as `Authorization: <key>`, with no `Bearer` prefix, by
POST to `https://api.linear.app/graphql`.

Set `LINEAR_API_KEY_READ` in two GitHub environments, `ci` and `production`: one registry
entry serves both the CI vitest mode and production, the trusted test job reads the `ci`
copy, and the deploy and the ops-script runner read the `production` copy, which the deploy
publishes to the Worker. Set `LINEAR_API_KEY_WRITE` in the `linear` environment only; it
never reaches the Worker.

Probes. The `ci` read copy: the trusted CI test job runs the real Linear client against the
`HUS` team (`linear-real.integration.test.ts` in the roadmap slice), and `pnpm
verify:evidence` fails the job unless a real call was recorded. The `production` read copy:
after the deploy that carries it, `GET /public/roadmap` on the API origin answers 200 — the
cache starts cold at each deploy, so that first answer came from the Worker. The write key:
with the value in that one process's environment as `LINEAR_API_KEY_WRITE`, `pnpm
linear:backup --out <file>` reads the whole board through it; dispatching `groom-linear.yml`
with `dry_run` left at true does the same from the `linear` environment in its preflight
job. Neither exercises "Write" — only a live grooming run does.

## Replace

Either key is drop-in: create the successor by §Obtain under the account that holds it, set
it, then revoke the old one from the same "Personal API keys" list — or, as an Admin, from
"Settings" > "Administration" > "API", which lists every key in the workspace with when it
was last used and revokes any of them. Third-party sources name the control "Revoke";
Linear's own text says only that keys are "revoked". Set the read key in both its
environments in one sitting and let its deploy follow; until that deploy the Worker runs on
the old value, so revoke it only afterwards.
