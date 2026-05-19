# CI HTTP Cassettes

The vitest integration tests for the AI service (`apps/api/src/services/ai/*.integration.test.ts`) exercise real Vercel AI Gateway calls — text inference, image generation, video generation. Calling the gateway on every CI run costs money and adds latency. The cassette layer records each unique request on first observation and replays the recorded response on subsequent runs from the GitHub Actions cache.

## How it works

```
test code
  └─ setupIntegrationClient()  [apps/api/src/services/ai/integration-setup.ts]
      └─ getAIClient(env, { fetch: cassetteFetch })  [CI vitest only]
          └─ createGateway({ fetch: cassetteFetch })
              └─ cassetteFetch(request):
                   1. hash = sha256(canonical(request))
                   2. cassette = store.read(hash)
                   3. hit → reconstruct Response, return
                   4. miss → real fetch, tee body, write cassette, return
```

The four cassette modules:

- `cassette/canonical-request.ts` — turns a `Request` into a deterministic descriptor (method, path+query, allowlisted headers, canonicalized body) and hashes it to 16 hex chars.
- `cassette/cassette-store.ts` — file-backed storage at `.ai-cassettes/{version}/{hash}.json`. Atomic writes via `.tmp + rename`.
- `cassette/recording-fetch.ts` — the fetch wrapper. Hit/miss/error policy (see below).
- `integration-setup.ts` — wires `cassetteFetch` into the production `getAIClient` factory only when `isCiVitest` (`isCI && !isE2E`).

The cassette is **invisible to test code**. Tests call `client.stream(request)` exactly as production code would.

## Caching policy

| Upstream result | Action |
|---|---|
| 2xx (success) | Cache. Subsequent identical requests replay this response. |
| 4xx (client error) | Cache. Tests can legitimately assert on rate limits, model deprecation, etc. |
| 5xx (server error) | **Do not cache.** Transient — caching would poison future runs. |
| Network error / throw | **Do not cache.** Pass error through. |

The `getGenerationInfo?id=<id>` path strips the `id` query before hashing — the id is gateway-assigned and non-deterministic across record/replay. Replay returns the most recent matching recording.

## When to bump `AI_RECORDING_VERSION`

The constant lives in `apps/api/src/services/ai/cassette/cassette-store.ts`. Bumping (`'v1'` → `'v2'`) orphans all existing recordings — the next CI run sees a clean cassette directory and re-records everything.

Bump when:

1. The serialized `Cassette` schema changes (the file format).
2. The header allowlist in `canonical-request.ts` changes (hash drifts).
3. The Vercel SDK ships a behavior change you want to retest against fresh recordings.
4. You deliberately want a clean refresh (e.g., after fixing a bug in our request-construction logic that all recordings have baked in).

Don't bump for:

- New test prompts → just let old hashes orphan naturally; they'll get evicted by GH cache LRU.
- Routine SDK patch upgrades → the SDK version is filtered out of the hash via the header allowlist.

## Forcing a local refresh

Cassettes live at `.ai-cassettes/v{N}/` (gitignored). To force a refresh of one specific recording:

```bash
rm .ai-cassettes/v1/<hash>.json
```

To wipe everything:

```bash
rm -rf .ai-cassettes
```

The next test run will record fresh entries against the real gateway. Local dev uses the mock client by default (`isLocalDev` branch in `setupIntegrationClient`), so to exercise the cassette path locally you must set `CI=true` and provide `AI_GATEWAY_API_KEY` + `DATABASE_URL`.

## What `verify:evidence --require=ai-gateway` actually proves

The evidence assertion (`scripts/verify-evidence.ts`) checks that the `service_evidence` table has at least one `ai-gateway` row after the test job runs. Both real calls and cassette replays write evidence rows — replay is treated as evidence that the integration code path was exercised.

This means a 100% cassette-replay run still satisfies `verify:evidence`. The original intent of the assertion ("we actually contacted Vercel today") is weakened in exchange for cost savings. If you need a periodic real-call signal, schedule a workflow that bumps `AI_RECORDING_VERSION` (or deletes the cache) before running tests.

## CI cache mechanics

The test job in `.github/workflows/ci.yml` uses `actions/cache@v4` for cassette storage:

```yaml
- name: Restore AI cassettes
  uses: actions/cache/restore@v4
  with:
    path: .ai-cassettes
    key: ai-cassettes-v1-${{ github.run_id }}-${{ github.run_attempt }}
    restore-keys: |
      ai-cassettes-v1-

- name: Save AI cassettes
  if: always()
  uses: actions/cache/save@v4
  with:
    path: .ai-cassettes
    key: ai-cassettes-v1-${{ github.run_id }}-${{ github.run_attempt }}
```

The unique save key + prefix `restore-keys` pattern: each run saves under a fresh key, but every run restores from the most recently saved key matching the prefix. New recordings accumulate; bumping the `v1` prefix in `AI_RECORDING_VERSION` cleanly retires the old set.

Blacksmith runners transparently route `actions/cache@v4` to their MinIO cache backend (25 GB/week per repo, 7-day LRU), so no special configuration is needed.

## Sequence-of-exchanges for media

Some logical operations issue multiple HTTP requests:

- Veo video generation returns base64 inline in one SSE response today, so it's one exchange.
- Future providers may return `{ type: 'url', url: '...' }` and the AI SDK falls back to a second `defaultDownload(url)` call.

The cassette layer handles this naturally: each fetch generates its own cassette entry keyed by hash. The first recording captures the gateway response containing the URL; replay returns the same URL; the SDK's follow-up fetch then hits a separately-keyed cassette entry. No special multi-exchange logic is needed at the cassette level.

## Diagnostics

The cassette store writes JSON files; you can inspect them directly:

```bash
ls .ai-cassettes/v1/
jq '.exchanges[0].status, .exchanges[0].headers' .ai-cassettes/v1/<hash>.json
```

To see which test produced which cassette, correlate by `recordedAt` and `recordedFromSha` (the `GITHUB_SHA` at record time).

## Fork PRs

GitHub Actions cache is read-only for fork PRs by design. Forks don't have access to repo secrets (including `AI_GATEWAY_API_KEY_RESTRICTED`), so the integration tests can't make real calls and the cassette layer never engages. The current behavior matches: fork PRs skip the AI integration tests at the env-config layer.
