# Growth measurement

The marketing site's anonymous visit and funnel counting, the campaign tag, the channel
question, the growth tables and views, the roles that read them, and the admin growth
dashboard. Read this for analytics, attribution or marketing-measurement work, a
campaign tag, the dashboard or its roles, or any change near the privacy policy's
website-measurement promises.

## The promise and its two guards

The privacy policy says the public website is measured by a counter we run ourselves,
that no third-party analytics service or third-party cookie exists anywhere, and that
the counter stores nothing on the device and ties nothing to an account
(`packages/shared/src/legal/privacy-sections.ts`, the website-measurement section). The
measurement keeps that by structure: nothing is written to or read from a visitor's
device, no consent banner exists, and the signed-in app — the signup page included — is
not instrumented. The system is two halves that never join. The anonymous half counts
visitors on the marketing site under a keyed daily hash that never reaches Postgres. The
identified half is the account: the campaign tag its signup link carried, and what the
account holder answered when asked.

Two guards hold the boundary. The arch rule `growth-seam`
(`packages/config/arch/rules/growth-seam.rule.ts`) refuses any query that joins a growth
table to an identified one. The app guard (`apps/web/src/lib/growth-guard.test.ts`)
sweeps the app's sources for any reference to the beacon; the one permitted touch is
reading the `?c=` campaign tag on the signup route.

## The beacon

The beacon script (`packages/ui/src/components/growth/init-script.ts`), embedded by the
marketing layouts, sends one `POST /e` per page view and per captured click: a
`text/plain` body over `fetch` with `keepalive` and no credentials, which needs no
preflight and survives navigation. The route is served on the marketing hostname itself
— a zone route on the product Worker — so the request is same-origin. Every link and
button on a built page is a captured event, named at build time from the page's own
markup; the beacon carries no free text. The wire contract is
`packages/shared/src/growth/beacon.ts`. The script counts only when the page's hostname
is the public site's, so a copy served anywhere else — the admin preview, a local build
— sends nothing.

The route answers 204 always: a known crawler (`isbot`) is answered and not counted, and
Redis unreachable is answered and not counted. Its rate-limit posture is `open` with one
edge-counted IP layer, because a counter outage must never take a marketing page down;
what an uncounted flood can do is bounded by the ceilings below, not by the counter
(`docs/RATE-LIMITING.md` §Failure posture).

## Counting

A visitor identifier is an HKDF of `GROWTH_HASH_SECRET` and the day, so it rotates daily
and is worthless across days. It exists only as a member of Redis sets under a TTL
(`apps/api/src/lib/redis/growth-keys.ts`), which is the only prune; nothing writes it to
Postgres. Every count is a set cardinality — one set family per table row's dimension
tuple, at hour grain and day grain both, because hourly sets do not sum to a day. One
Lua script performs every write a beacon causes.

Three ceilings bound a flood (`packages/shared/src/growth/ceilings.ts`). A set stops
growing at its member ceiling and the bucket is flagged `overflow`, so a reader reports
the ceiling as a floor ("100,000+") rather than as a total. Each family's dimension
index has a ceiling past which a new value folds to `other` (`/other` for paths). One
address can mint a bounded number of identifiers per day; past it a beacon is dropped,
not folded. Reaching a ceiling latches one Sentry event per set per bucket.

Registration starts are counted on the server as a set of caller-address identifiers —
never a visitor hash, which the registration route never sees. A decoy shadow set is
written alongside so response timing does not reveal which addresses are new
(`apps/api/src/slices/growth/domain/count-registration-started.ts`). A finished
registration is an account row, joined at read time.

### The rollup

The job `growth.rollup.v1` (idempotency class `natural`) reduces the sets into the
growth tables. The hourly schedule enqueues one job per hour of the trailing TTL window;
each upserts on the row's unique dimension tuple inside one transaction. An hour whose
keys expired before it was rolled up fails loudly under the `growth_rollup_hour_lost`
fingerprint rather than writing a zero. A value is written only with evidence the store
still holds it: a set cardinality vouches for itself, and a key's lifetime is a fact
about that key, never about its family. The argument in full is the docblock of
`apps/api/src/slices/growth/domain/rollup.ts`.

## The campaign tag

A campaign tag is a label shared by everyone who clicked the same link, carried as `?c=`
on the URL and forwarded in the marketing site's own hrefs — never stored on the device.
The `campaigns` table is the allowlist: a visit with no tag counts as `direct`, an
unrecognised tag as `unknown`, both seeded and never retired
(`packages/shared/src/growth/patterns.ts`). Tags are minted and retired through
registered admin operations with inverses and are never deleted, because growth rows are
kept forever and reference them. Registration records the tag on `user_acquisition`
inside the registration transaction — the seam, and the only place the two halves touch.

## The channel question

The app asks where the person came from at two moments, in order: after signup, and — if
that one was skipped — again once a payment has completed, because someone who has just
paid is not the person who had just arrived. The answer is a closed set
(`GROWTH_CHANNELS`, `packages/shared/src/growth/enums.ts`) and never free text, because
the answer is read by a model through a read-only database role and no scrub separates a
genuine answer from an instruction. The server alone decides which prompt, if any, is due
(`apps/api/src/slices/identity/domain/account/acquisition-source.ts`); the client renders
that and stores nothing on the device, so a skip on one device holds on every other. The
answer is single-writer: the first to land stands, a later one changes nothing, and once
it lands the question is closed for good. A skip records only which moment was skipped and
moves forward only, so a stale tab cannot reopen the earlier prompt; a skip at the later
moment ends the asking but never closes the question — only an answer does that, from
either moment. Both the tag and the answer are saved on `user_acquisition`, and every read uses
`primary_source = coalesce(self_reported_channel, campaign)` — the person's answer over
the software's (`packages/db/src/schema/views/acquisition-sources.ts`). The routes are the
acquisition-source pair on the identity slice
(`apps/api/src/slices/identity/routes/account-profile-routes.ts`).

## Tables, views and reads

The growth tables (the `growth-*` schema modules and `campaigns`) hold aggregates and no
identity, are unique on their dimension tuple, and are never deleted. `user_acquisition`
is identity-owned and goes with the account. Views (`packages/db/src/schema/views/`) are
Drizzle-managed and owned by the slice that reads them (`VIEW_OWNER` in
`packages/config/arch/rules/single-writer-per-table.rule.ts`). Reads join and nothing is
copied, so a past week's figures change when its accounts do.

`growth_weekly` is a cohort by account-creation week, with `started` bucketed by the
event's own week. `finished` drifts below `started` as accounts are hard-deleted; that
drift is the deletion promise showing. Weekly uniques do not exist — the hash rotates
daily — so a weekly figure is daily uniques summed and is labelled so wherever it
appears. `acquisition_sources` projects no identifier.

Another slice reaches a growth table only through the slice's published doors
(`apps/api/src/slices/growth/public/`): the admin plane writes `campaigns` through a door
that takes the caller's transaction handle and commits inside it; identity counts a
registration start through a door that takes the caller's address; a dev-only seed fills
fixtures. Reads over tables no view exposes go the same way.

### The product-entry marginal

`growth_hourly_product_entry` counts distinct visitors who clicked through to product
entry with no campaign dimension: a person counts once however many campaigns they
arrived under, so the figure is exact and never a sum over campaign rows. It exists at
hour grain only, on `marketing_hourly`; `marketing_daily` emits nothing for it, because a
day row is its own set cardinality and never a sum of hours
(`packages/db/src/schema/views/marketing.ts`).

## Roles

Two admin roles exist, `operator` and `growth-viewer` (`packages/shared/src/admin/roles.ts`).
A viewer reaches the growth dashboard and the read operations behind it, nothing else.
The route-keyed role map is the primary control and default-denies; a contract's
`allowedRoles` may name the viewer only on a read; the engine refuses by role before it
opens anything; the SPA's navigation filters on role; notification and digest recipients
derive from the operator subset of the role map; the admin test battery pins the
refusals. Detail: `apps/api/src/slices/admin/CLAUDE.md`.

The marketer's tool reads the views as the Postgres role `growth_reader`, which holds
`SELECT` on those views and nothing else; no view carries user-typed text. Standing the
role up, adding a viewer, and proving both: `docs/runbooks/infra/growth-reader-role.md`.

## The marketing preview inside admin

The dashboard's click overlay frames a copy of the marketing site that the admin origin
serves under `/preview`, because the public site's headers deny framing and stay so. The
copy is a second build of the same source; the beacon's hostname guard keeps it from
counting. Build mechanics: `docs/BUILD-AND-CI.md` §The marketing preview build.

## The dashboard's controls and figures

A figure's scope statement is load-bearing. The page draws its controls once and each
panel answers to a subset of them; a panel a control does not reach looks exactly like
one it does, so every panel — and the exported file — states which of its figures the
campaign selection reaches. The declaration (`CampaignScope`,
`apps/admin/src/components/growth/panel-scope.ts`) is a required prop of the panel
frame, so a change that adds a figure or a control owes that sentence. The freshness
line — the newest day the data reaches — comes from a read no control narrows, so it
cannot follow the window; deriving it from the panels' own rows would let a narrowed
range hide stale data. The day range is an arbitrary start to end; reads are capped at
`MAX_GROWTH_READ_WINDOW_DAYS` (`packages/shared/src/admin/ops.ts`) and never poll.

## Known biases

- Network address translation: several people behind one address can count as one
  visitor, and one caller for the registration-start count.
- Ad blockers: a share of the audience never sends the beacon, so every count is a
  floor.
- Cross-day residual: a person who clicked a tagged link, returned days later by typing
  the URL, and answered nothing records as `direct`. No tool that keeps the promise
  recovers that person.
- No weekly uniques: the hash rotates daily; weekly figures are daily uniques summed.
- The anonymous funnel steps — registration started and product entry — are lower bounds
  of the identified step that follows them.
- Click counts cover the controls present in the built page, not ones that appear after
  interaction.

## The marketer's playbook

- Mint a campaign through the campaign operation, then tag every link you control with
  its `?c=`.
- Give each channel its own path on the site that lands on the welcome page with the tag,
  so a URL typed from memory still attributes.
- Read the channel answers beside the tag counts; where they disagree, the answer wins.

## Deliberate limits and the deferred table

Never, by ruling: a per-person pre-signup path; device storage of any kind; an
ad-platform conversion feed; instrumentation inside the app, the signup page included;
stored user-typed text; session replay, pointer heatmaps or scroll timelines; email open
tracking; weekly uniques.

| Deferred                                                                                                             | Trigger                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A short detail beside the channel answer ("which podcast"), human-eyes only, never in a view the reader role reaches | the founder wants the specific behind a channel                                      |
| Promo codes redeemable at top-up                                                                                     | the first creator or podcast deal                                                    |
| Server-side ad-platform conversions                                                                                  | paid search demonstrably scaling and the privacy policy's advertising line rewritten |
| A/B testing on the marketing site, page-level or time-split only, never visitor assignment                           | a variant worth testing                                                              |
| Materialised views                                                                                                   | a dashboard query over 500 ms                                                        |
| A weekly emailed digest of `funnel_weekly`                                                                           | the marketer's first monthly report                                                  |
| Third-party marketing tools (SEO, CRM, broadcast email, search ads)                                                  | a sales motion                                                                       |
