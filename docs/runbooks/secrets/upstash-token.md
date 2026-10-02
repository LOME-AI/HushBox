# Upstash Redis token

Obtain the Redis REST token and reset it. A reset invalidates the standard and read-only tokens together and leaves the REST URL unchanged; paid admission refuses until the deploy carrying the new token completes. Design: `docs/SECRETS.md`.

## Obtain

### `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

Upstash console -> "Redis" -> the database -> the "REST" tab among its connection details, which lists `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` with copy buttons (the tab's placement on the page was inferred during research, not read from a screen). The URL has the shape `https://<region>-<name>-<id>.upstash.io` and identifies the database; the token is an opaque string the console displays whenever the page is opened — nothing in Upstash's documentation calls it shown-once.

Take the "Standard" token, which "has full privilege over the database". The "Read-Only Token" switch beside it yields a token that permits read commands only and additionally refuses `SCAN` and `KEYS`; the Worker writes (admission holds, rate-limit counters, OPAQUE challenge state) and the billing auditor iterates with `SCAN`, so the read-only token serves neither. The `@upstash/redis` client takes exactly these two values (`apps/api/src/lib/context/factories.ts`, `apps/api/src/scheduled.ts`) and fails fast when either binding is absent.

Write the offline copy of the pair. Set both in the `production` environment; they are coupled and ship in one publish.

Probe:

```
curl "$UPSTASH_REDIS_REST_URL/ping" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

A live pair answers `200` with `{"result":"PONG"}`; a stale or wrong token answers `401` with `{"error":"WRONGPASS invalid password"}`. After the deploy, a paid run being admitted is the same proof from inside: admission fails closed when Redis refuses.

## Replace

Upstash has no per-token rotation. The one reset is the database's password reset, which invalidates the Standard and Read Only tokens together and leaves the URL unchanged. Where the console places that action, and what its control is labelled, could not be established from Upstash's documentation; the documented path is the Developer API, authenticated with the account email and a Developer API key made in the console (that screen was not researched):

```
curl -X POST "https://api.upstash.com/v2/redis/reset-password/<database-id>" -u "<account-email>:<developer-api-key>"
```

Its response carries no credential — read the new token from the "REST" tab afterwards. Whether the old token dies at the instant of the reset was inferred during research, not confirmed. Sequence: reset, write the offline copy, set `UPSTASH_REDIS_REST_TOKEN` in the `production` environment, run the deploy; paid admission refuses from the reset until that deploy completes.
