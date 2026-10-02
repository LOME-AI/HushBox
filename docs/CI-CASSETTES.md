# CI HTTP Cassettes

The models-slice adapter tests exercise OpenRouter calls (text inference, image
generation, video generation) and Brave web search. Calling either on every CI run costs
money and adds latency. The cassette layer records each HTTP exchange the first time it is seen and
replays it thereafter, so CI is **record-on-miss**: the first uncached request is a real
charged call (using the vendor's restricted CI key), stored in
the shared cassette store; every identical request afterward replays from that store.

- **Warm cache** (steady state) = all replays, **zero charged calls**.
- **Cold cache** (a brand-new test, a version bump, or a run that cannot reach the
  store) = real calls for the misses, recorded for next time.

There is no separate out-of-band recording step and CI is not "100% replay" — it records
what it is missing. Cassettes are CI-only, by doctrine: there is no local cassette
system and there never will be one. Locally the adapter integration suites run the
deterministic mock with no skips; service-evidence rows are written only in CI, behind
the real-call path.

## Where the vendor is chosen

All three ways AI inference is served are selected in one place —
`resolveModelProvider` in the models slice
(`apps/api/src/slices/models/adapters/resolve-model-provider.ts`):

| Environment      | Provider                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dev / test / E2E | deterministic **mock** provider — no key, no cassette, no evidence. The pull-request phase of CI runs under `test` mode and lands here.                             |
| CI-vitest        | **real** provider whose SDK `fetch` is the record-on-miss cassette, wrapped so the first successful inference event writes `openrouter-inference` service-evidence. |
| production       | **real** provider over plain `globalThis.fetch` — no cassette, no evidence.                                                                                         |

Web search is chosen the same way by `resolveSearchProvider` beside it: the fake search adapter
wherever inference is mocked, Brave over the same cassette store in CI-vitest, and Brave over
plain `fetch` in production. Its `brave-search` evidence row is written after every search that
resolves, recorded or replayed, so a replay satisfies `verify:evidence --require=brave-search`
as it does the OpenRouter name.

## How it works

```
adapter test
  └─ createCassetteFetch({ store, mode })          [cassette/recording-fetch.ts]
      │    store = createCassetteStore(...)        [cassette/cassette-store.ts]
      │    mode  = cassetteModeFor()               [cassette/mode.ts]  → 'record'
      └─ passed through the adapters' fetch option (the cassette/fixture seam)
          └─ createOpenRouter({ fetch })
              └─ on each request:
                   1. hash = sha256(canonical(request)).slice(0, 16)
                                                    [cassette/canonical-request.ts]
                   2. key  = hash on the request's first occurrence in the
                             open scope, hash-n after n identical ones
                   3. cassette = store.read(key)
                   4. hit  → reconstruct Response, return
                   5. miss → record mode: real fetch, record on success, return
```

The cassette modules live at `apps/api/src/slices/models/adapters/cassette/`:

- `canonical-request.ts` — turns a `Request` into a deterministic descriptor (method,
  path+query, allowlisted headers, canonicalized body) and hashes it to 16 hex chars
  (an 8-byte sha256 prefix — ample for a CI run's cardinality). The header allowlist is
  deliberately pared to `content-type` + `accept`: OpenRouter carries the model id in the
  request **body** (`body.model`), not a header, so two models with the same prompt
  already hash differently via the body. This diverges from the legacy Vercel-gateway
  header set on purpose — auth, SDK-version, and per-request identifier headers are
  filtered out so record and replay of the same logical request hash identically.
  A Brave search keys by path and query; its `X-Subscription-Token` header is outside the
  allowlist, so a replaced key replays the same recording.
- `cassette-store.ts` — file-backed storage, one file per key, at
  `.ai-cassettes/{version}/{key}.json` (atomic writes via `.tmp` + rename). The directory name, the object-key prefix and
  `AI_RECORDING_VERSION` are owned by `@hushbox/shared/cassettes`, so the harness and
  the CI sync script cannot drift apart.
- `recording-fetch.ts` — the fetch wrapper (`createCassetteFetch`) and the occurrence
  scope (§Multi-exchange operations); hit/miss/error policy: §Caching policy.
- `mode.ts` — `cassetteModeFor()` returns `'record'` (record-on-miss). The
  `'replay-only'` value still exists on the `CassetteMode` type but is exercised only by
  the cassette unit tests, never selected at runtime.
- `failure-fixtures.ts` / `media-failure-fixtures.ts` — hand-curated synthetic error
  exchanges (`createFixtureFetch`) injected at the same fetch seam, since real
  failures are never recorded.

The cassette is invisible to test code — tests call the adapters exactly as
production code would; only the injected fetch differs.

## Caching policy

In `record` mode, a miss goes to the real gateway and the result decides:

| Upstream result     | Action                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2xx / 3xx (success) | Cache under its key (§How it works); an identical request at the same occurrence replays this response.                                                     |
| 4xx (client error)  | **Do not cache.** A failed request isn't billed, so re-running it live is free — and caching a transient auth/plan/rate-limit failure would replay forever. |
| 5xx (server error)  | **Do not cache.** Transient — caching would poison future runs.                                                                                             |
| Network error/throw | **Do not cache.** Pass the error through.                                                                                                                   |

Deterministic error paths come from the failure fixtures, never from recordings.

`replay-only` mode throws `CassetteMissError` on a miss. It is used only by the cassette
unit tests to assert miss behavior — CI never runs in this mode.

## When to bump `AI_RECORDING_VERSION`

Bumping `AI_RECORDING_VERSION` orphans all existing recordings — the next run records fresh
into a clean directory. Bump when:

1. The serialized `Cassette` schema changes (the file format).
2. The header allowlist in `canonical-request.ts` changes (hashes drift).
3. The AI SDK / OpenRouter provider ships a behavior change you want fresh
   recordings against.
4. You deliberately want a clean refresh (e.g., after fixing a request-construction
   bug that all recordings have baked in).

Don't bump for new test prompts (old hashes orphan naturally — nothing reads them
again) or routine SDK patch upgrades (the SDK version is filtered out of the hash via
the header allowlist). Note that orphaning is not deletion: the store has no eviction,
so orphaned objects stay in the bucket. They are no longer restored — a restore is
scoped to the current version's prefix — so a bump costs bucket space and nothing
per run. Reclaiming the space is a manual delete on the bucket.

## Recording

Recording happens automatically on a miss, in CI only (with the restricted CI keys);
there is no local recording path (locally the
suites run the mock; see the doctrine above). Cassettes live at `.ai-cassettes/v{N}/`
(gitignored). To force one recording to refresh, delete its object from the store —
deleting the local file alone achieves nothing, because the next run's restore brings
it straight back:

```bash
rm .ai-cassettes/<version>/<key>.json   # local workspace only
```

To wipe everything locally:

```bash
rm -rf .ai-cassettes
```

The dev/E2E placeholder keys (`mock-openrouter-key`, `mock-brave-search-key`) are refused on
the CI-vitest recording path: recording against one would spend a CI run on a refused call.

## What `verify:evidence --require=openrouter-inference` proves

`scripts/verify-evidence.ts` checks the `service_evidence` table has at least one
`openrouter-inference` row (`SERVICE_NAMES.OPENROUTER_INFERENCE`) after the test job. Both real calls and
cassette replays write evidence rows — replay counts as evidence that the integration
code path was exercised, so a warm-cache (100% replay) run still satisfies the assertion.
It proves the integration code path ran, not that a live call happened this run; a
cold-cache run or a version bump is **not** required to satisfy it.

The catalog read is a separate name, `openrouter-catalog`, written by an uncassetted live
read; no replay satisfies it (`docs/BUILD-AND-CI.md` §Real external services in CI).

## CI cache mechanics

Cassettes live in one R2 bucket shared by both repositories and every branch — not
in a per-repo, branch-scoped Actions cache. The test job in
`.github/workflows/ci.yml` brackets the suite with two steps
(`scripts/cassette-store.ts`, logic in `scripts/lib/test-run/cassette-store.ts`):

```yaml
- name: Restore AI cassettes
  if: github.event_name != 'pull_request'
  run: pnpm tsx scripts/cassette-store.ts download
  env: # the four CASSETTE_R2_* secrets

- name: Store new AI cassettes
  if: always() && github.event_name != 'pull_request'
  run: pnpm tsx scripts/cassette-store.ts upload
  env: # the four CASSETTE_R2_* secrets
```

Storage is one object per recording, at `cassettes/{version}/{key}.json` (the key:
§How it works) — the same layout as the local cassette directory, so bumping `AI_RECORDING_VERSION`
changes a directory segment on both sides and retires the old objects with no other
change. `download` lists only the current version's prefix, so a retired generation
is never fetched again; there is no eviction, so it does stay in the bucket. That
object granularity is what carries the three properties the old unique-cache-key
scheme bought:

- **Nothing is ever recorded twice.** `download` restores the union of everything
  any trusted run has recorded of the current version, on any branch in either
  repository, so a request that has been recorded once is a replay for every run
  afterwards.
- **A save never overwrites.** Each upload carries `If-None-Match: *`. Two runs
  that recorded the same request race harmlessly: the first object stands and the
  second is told so, rather than replacing it. The same rule makes every entry
  permanent: no later recording, from any branch of either repository, replaces it,
  so a recording that is wrong to replay is retired only by bumping
  `AI_RECORDING_VERSION`, which retires every recording of the generation at once
  (§When to bump `AI_RECORDING_VERSION`).
- **A failed save cannot poison the store.** A PUT is one whole object, so there
  are no partial writes, and `upload` only ever adds keys the bucket lacks. It runs
  `if: always()` because a recording made by a failed run is still the one the next
  run replays.

Both steps are best-effort: an unreachable or unconfigured store logs a loud line
and exits 0, leaving the run with a cold cache — which the record-on-miss harness
handles by recording live. Only a half-configured store (some of the four secrets
present, some absent) fails the step, because that is a mistake nobody would
otherwise notice. Fork pull requests run the mock provider and are excluded from
both steps by the `if:` guards above, so an untrusted run never reaches the bucket
or its credentials.

## Multi-exchange operations

Some logical operations issue more than one HTTP request: a media response carrying a
URL the SDK then downloads, or a video job polled until it finishes. Each exchange is
its own cassette entry. Distinct requests key apart by their hash; a request repeated
byte-for-byte keys by its occurrence within the open cassette scope, so a poll loop
records as a sequence and replays as that sequence, through to the recorded terminal
answer.

Whoever owns a logical run's boundary opens the scope, and each new scope restarts the
count. The adapter integration harness, `useIntegrationProvider()`
(`apps/api/src/slices/models/adapters/integration.setup.ts`), opens one at suite start
and before every test. Two tests sending identical requests therefore each replay the
recording from its start, and the second never keys past it into a live, charged call.
The provider the harness hands out refuses to infer with no scope open, on every
machine, and its error names the lifecycle to take.

Replay paces a poll loop at a short fixed interval whenever the current recording
generation holds any recording at all. A generation holding none polls at the
provider's own cadence, the only one safe against the live endpoint
(`apps/api/src/slices/models/adapters/resolve-model-provider.ts`). A new polled request
recorded into a populated generation therefore makes its live polls at the replay
interval.

## Diagnostics

Cassette files are JSON — inspect directly:

```bash
ls .ai-cassettes/<version>/
jq '.exchanges[0].status, .exchanges[0].headers' .ai-cassettes/<version>/<key>.json
```

Correlate recordings to tests by `recordedAt` and `recordedFromSha`.

## Fork PRs

Fork PRs never reach the cassette store, on two independent grounds: GitHub withholds
repository secrets from a fork-triggered run, so the `CASSETTE_R2_*` credentials are
empty; and the restore/store steps are guarded off the `pull_request` event outright
(see §CI cache mechanics), so they do not run at all. No cassettes to replay and no
`OPENROUTER_API_KEY_RESTRICTED` to record with — cassette-dependent integration tests
cannot pass there.
