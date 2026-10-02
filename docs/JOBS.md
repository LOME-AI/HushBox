# Jobs

The mechanics of the jobs system: how a `jobs` row is enqueued, claimed, executed,
retried and retired. The doctrine — a `jobs` row is the only mechanism for must-happen
async work, cron never delivers, dead rows are redriven or discarded and never
auto-deleted — is in `docs/CODE-RULES.md` §Jobs & Async and `docs/ARCHITECTURE.md`
§The jobs system. Read this when adding a job type, changing a handler, or diagnosing a
stuck or dead row or an auditor's page.

## Enqueue

A job is an `INSERT` inside the domain transaction that triggers it, so the row commits
atomically with its cause. The payload is validated by the handler's Zod schema at
enqueue, inside that transaction — a malformed payload fails the enqueuing operation and
never creates a doomed row. The post-commit `wake()` is structural, and a caller writes
none: enqueue and redrive — the two transitions that make a row claimable now — accept
only a transaction handle carrying the job-wake capability (`JobWakeCapable`,
`apps/api/src/lib/jobs/wake-capability.ts`) and record the row's shard on it, and the
runtime boundary that minted the capability wakes those shards once the transaction has
committed. A transaction that rolls back wakes nothing, so an admin preview leaves no
trace. The wake is lossy and buys enqueue-to-first-attempt latency only; delivery is the
dispatcher's alarm. A new runtime context that opens database scopes mints the capability
on the handle it creates and discharges it after commit, both in one scope; a context that
never mints cannot enqueue, because an ungranted handle fails to compile — which is what
keeps the conversation DO, whose connection lives as long as the object, outside the
mechanism by construction. The arch rule `job-wakes-have-one-path`
(`packages/config/arch/rules/`) holds the shape: a scope that mints discharges, only the
capability module produces the brand, and only the discharge and the stuck-row auditor
(§Liveness) call the nudge.

## Dispatcher

One Durable Object per shard (`default`, `bulk`), stateless except its alarm and the
shard name it persists to its own storage. Each pass:

1. Re-arm the alarm first (`now + 30s`), so a crash mid-pass is recovered by the next
   alarm.
2. Dead-letter rows that have exhausted their failure cap, at claim time.
3. Claim a batch with `FOR UPDATE SKIP LOCKED` in priority order; a `running` row whose
   lease has expired is reclaimable.
4. Execute the batch.
5. Re-arm to `min(next nextAttemptAt, idle decay)`. Idle decay grows from 60 seconds to
   30 minutes and applies only when no work is pending or scheduled; any `wake()` resets
   it.

## Handlers

The handler registry is the authoritative list of job types. A registration declares its
payload schema, an execution budget (`maxExecutionSeconds`), failure caps, one mandatory
idempotency class, and one of two shapes:

- **One-shot** — work bounded by a constant. One invocation runs to a terminal outcome.
- **Chunked** — work that scales with a caller-controlled input. The registration
  supplies a cursor and one unit of work; the framework owns the loop, checkpoints the
  cursor into the payload before the budget runs out, and resumes from it on the next
  claim. A chunk reads no clock and writes no checkpoint of its own (`chunkedWork` in
  `apps/api/src/lib/jobs/chunked.ts`).

A single execution is hard-bounded. The dispatcher kills a handler still running at its
budget — it stops waiting and records the attempt as a failure; a late write from the
abandoned handler loses at the completion fence — and no mechanism extends a running
execution. A budget is a declaration that the work — one chunk, for chunked work — fits
inside it while the handler's dependencies stay inside the timeouts they declare; a kill
is an auditor's page (§Liveness). Budgets are bounded by one dispatcher pass, so work
that can outgrow a pass is chunked, never stretched. The row's lease is derived from the
budget — budget plus a fixed reclaim margin — so no registration can order the two
wrongly, and a kill lands while the killer still holds the row.

The idempotency classes:

- `txn` — the effect and the terminal transition commit in one transaction: the handler
  writes the transition through its execution's `completeWithinTx` and returns what it
  hands back. One-shot only — a chunk is handed its payload and cursor alone, so it
  cannot keep that promise.
- `natural` — the effect is naturally idempotent (an upsert, a delete-if-exists).
- `providerKey` — the external call carries an idempotency key the provider honours.
- `byEventId` — the effect is keyed on a provider event id already recorded.

A handler returns `ok`, `fail` or `dead` (a `txn` handler, the outcome `completeWithinTx`
handed it). `yield` checkpoints progress without consuming a retry, and only the chunk
loop issues it. Checkpoint writes pass the same `claims` / `claimedBy` fence as
completion, so a zombie executor cannot corrupt a live claim.

Every job must be able to succeed for every legal payload; already-done is success. A
job that cannot reach success is a code defect in the enqueuer, handler or schema, never
an operational state.

## Timing and retention

- Enqueue to first attempt is tens of milliseconds while the dispatcher is awake.
- Retries run at exact backoff — `failures⁴` seconds with ±10% jitter, capped at one
  hour.
- Crash recovery is the lease — the declared execution budget plus a fixed reclaim
  margin — plus at most one alarm interval.
- `succeeded` rows prune after seven days.
- `dead` rows persist until explicitly redriven, or discarded by an audited admin
  operation whose `admin_audit` row is the permanent record; discarded rows prune on
  retention. An unresolved dead row is never auto-deleted.

## Liveness

Two read-only auditors share the fifteen-minute `jobs-health` schedule.

The stuck-row auditor pages on stuck jobs and `wake()`s both shards. The page is the
signal; the wake covers the one state the dispatcher cannot leave
on its own — a shard holding no alarm at all, the documented platform alarm-wedge bug —
and a lost wake that left a due row waiting on a long idle rung. A live dispatcher claims
any due row within its first idle rung without it (§Dispatcher), and an enqueue commits
with its wake attached (§Enqueue), so the auditor is detection plus a nudge, never the
cold-start path and never a second delivery path. The rescue is for that reason not
provable end to end: the dispatcher's own alarm claims a backdated row before any
pre-fire window could show it still waiting, so the auditor's E2E coverage is composition
only (`docs/SCHEDULES.md` §Firing a schedule from a spec).

The execution-budget auditor pages naming each job type that recorded a budget kill
inside a trailing window, and nudges nothing: the row's own retry redelivers the work,
and what a kill needs from a human is a diagnosis. Two causes reach the page and it
cannot tell them apart — the budget is wrong for the work, a defect in the handler or its
registration, or a dependency ran past the timeouts it declares, an operational condition
and not a defect. Either way the kill has already cost the row one of its attempts, so
the page fires on the first kill rather than waiting for the dead-letter alert at the end
of the retries. The repair is per type, which is why the page names types and not rows.
The window spans several cadences, so a late or skipped tick still reports the kill and a
type that keeps hitting the wall keeps paging; it is bounded, so a repaired type stops
paging on its own with no state for anyone to clear.
