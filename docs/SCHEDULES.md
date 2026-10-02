# Schedules

The Worker's cron surface: which schedules exist, what each runs, how a dead cron isolate
is noticed, and how a spec fires a schedule. The schedule registry is
`apps/api/src/composition/cron-schedules.ts`; `wrangler.toml` mirrors its expressions and a
test holds the two equal. Cron hosts pollers, retention deletes and read-only auditors,
never delivery (`docs/CODE-RULES.md` §Jobs & Async).

## The schedules

Dispatch is by schedule name, never by expression; the entries one trigger runs are
isolated from each other, so one entry's failure is captured under its own fingerprint and
its siblings run on.

- **jobs-health**, every fifteen minutes — the jobs-health auditor, which nudges the
  dispatcher awake, and the job-lease-timeout auditor.
- **hourly** — the model catalog refresh (jittered in production), media garbage
  collection, the ledger-conservation probe, the snapshot-drift probe, the payments status
  auditor, the backup staleness auditor, and the growth rollup enqueue.
- **access-log**, every six hours — the access-log auditor.
- **daily-retention**, once a day — the retention deletes (idempotency keys, succeeded
  and discarded jobs, account-deletion events, expired verification tokens, stale device
  tokens, unconfirmed newsletter subscribers), the admin digest enqueue, the public stats
  snapshot, and the backup retention auditor.

## The check-in

The four schedules share one trigger mechanism, so one monitor detects the whole isolate's
absence. The jobs-health schedule checks in to a Sentry cron monitor before its entries run
and after they settle, through the Telemetry port; the monitor is upserted from code with
the schedule's own expression from the registry, so its expected cadence is derived, never
configured. A missed check-in becomes a Sentry issue; an Issues alert rule filtered on the
monitor's slug is what routes it to a human, and that rule is the one step outside the repo.
Nothing watches the monitor: the chain of watchers ends at the vendor by design, the same
line the gate-auditor draws for itself.

## The dev ticker

Under `pnpm dev` a ticker fires each schedule at its real cadence, in UTC, against the local
stack, with the console telemetry sink. Under the E2E env mode the ticker is off and a spec
fires the schedule it needs.

## Firing a schedule from a spec

A spec fires one of the Worker's deployed schedules by name through `fireCronSchedule`
(`e2e/helpers/cron.ts`) and resumes once the whole handler, `waitUntil` work included, has
finished. The dev-server ticker is off under E2E, so the spec's fire is the only one and
its effects are the spec's own. A fire proves composition — every entry on the schedule
constructed and ran under the real Worker's bindings, the fault class an integration test
building its own dependencies cannot see — and nothing about any entry's outcome, because
the cron runner turns an entry's failure into telemetry. `e2e/api/cron.spec.ts` fires every
schedule for exactly that proof. An entry earns a spec of its own only when its effect is
observable from the spec; entry behaviour is otherwise proven at the integration layer
against live local infrastructure. The jobs-health auditor's rescue is provable at neither
layer from a fire: a live dispatcher claims a due row within its first idle rung, so no
pre-fire window can show the row still waiting (`docs/JOBS.md` §Liveness).
