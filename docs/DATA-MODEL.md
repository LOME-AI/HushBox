# Data model

What the tables mean: the role of each group, the columns whose semantics are not
obvious from their names, and the deletion rules. Conventions and schema shape tests are
in `packages/db/CLAUDE.md`; which slice may write which table is the
`single-writer-per-table` arch rule's map, asserted complete in both directions against
the schema barrel. Read this when adding or reading a table outside the slice you are
working in, or when a change touches deletion.

The groups below describe roles, never the roster — the schema barrel is the roster.

## Money and usage

- `wallets` — unique per user and type.
- `ledger_entries` — double-entry legs; running balances exist only on user-wallet legs.
- `usage_records` — one per charge; `runId` groups a run's charges; records both payer and
  sender. The content FK is nullable and `SET NULL` on deletion, with an insert-time
  invariant that billed implies the run persisted content.
- `llm_completions` / `media_generations` — per-call provider detail; reasoning token
  counts ride `llm_completions.reasoningTokens`.
- `payments` — the durable pre-claim for card charges.
- `member_budgets` / `conversation_spending` — lifetime cumulative allowances; semantics
  in `docs/BILLING.md` §Group Funding.
- `allowance_spending` — day-keyed free-allowance spend, upserted at settlement; there are
  no reset jobs because the day is part of the key.
- `public_stats_snapshots` — one row per daily snapshot of the anonymized public-stats
  payload, kept forever.

## Conversation and content

- `users` — carries `lockedAt` and `deletionRequestedAt`.
- `messages` — unique on conversation and sequence. A non-null `deletedAt` marks a message
  whose content an account deletion erased (§Deletion): the row carries no content items,
  and reads report it as deleted, which the app renders as "Message deleted".
- `content_items`, `conversations`, `conversation_members`, `conversation_forks`.
- `epochs` / `epoch_members` — the key-rotation epochs and each member's floor.
- `shared_links` — `revokedAt` and `expiresAt` are enforced lazily at read.
- `shared_messages` — carries `createdBy` and no revoke or expiry column: a standalone
  message share ends only when its message row or its creator's account is deleted. A
  share of a message whose content an account deletion erased still resolves, and shows
  the message as deleted.
- `conversation_members.lastReadSeq` — the monotonic read cursor behind cross-device
  notification dismissal.

Assistant text stores the model's return verbatim, framed with HushBox's reasoning and search
rows (each search's queries and its sources' titles and URLs), parsed on demand. Search sources
live only in that encrypted text, so deleting the message deletes them.

**The server mints every message id.** A request never supplies one: the run-start and attach
responses return the user and assistant message ids the server minted, and the user-only
message route mints its own. A client-chosen id could collide with an existing row and fail
settlement after its answer streamed.

**The epoch floor governs reads, not identifiers.** An identifier of a message below a
member's epoch floor can still reach them: the floor decides which rows a member reads,
never which identifiers a row or an event carries, so every field naming another message
— a visible message's `parentMessageId`, a `fork:created` broadcast's `tipMessageId` —
passes its id through unfiltered. Holding such an id confers nothing, and neither does
supplying one. The floor is enforced where content is read and where publication is
authorized: the history page filters on it, share creation refuses a message below it
with the same not-found an absent message gets, and the member presign path demands an
`epoch_members` row for the message's own epoch.

## Delivery and platform

- `newsletter_subscribers` — consent evidence plus confirm and unsubscribe tokens;
  complaint suppression is sticky. Retention purges a `pending` row one confirm-token
  lifetime after its token expires. A subscriber with a `newsletter_deliveries` row is
  never purged: its kept-forever children refuse the delete (`NO ACTION`), because it
  confirmed and was lawfully mailed.
- `newsletter_issues`; `newsletter_deliveries` — one row per recipient, kept forever, the
  duplicate-send referee; `newsletter_webhook_events` — one row per provider `svix-id`,
  the `byEventId` replay referee.
- `device_tokens` — native FCM tokens and web push subscriptions in one table.
- `notification_preferences` — per-category toggles, quiet hours, IANA timezone.
- `modelCatalog` — one row per model, the cron-refreshed OpenRouter snapshot.
- `idempotency_keys` — `kind`, body hash, lease, claims fence; the run referee.
- `jobs` — `docs/JOBS.md`.
- `admin_audit` — append-only, enforced by triggers.
- `service_evidence` — one row per seam a CI step requires, written after a real call the
  test made against the endpoint the environment registry resolves for that service; for
  the object-store rows that endpoint is the local emulator outside production, so they
  prove request construction, never that Cloudflare accepted anything. A test that fakes
  the transport writes none, arch-enforced.
- `banner_config` — the single active announcement banner; `banner_dismissals` — per
  user, the dismissed message-set hash.
- `feedback` — in-app feedback reports; instructions, preferences, verification tokens.

## Marketing measurement

The anonymous half of `docs/GROWTH-MEASUREMENT.md`: aggregates that hold no identity and
are never deleted.

- `campaigns` — the tag allowlist every growth row references; `direct` and `unknown`
  are seeded; a tag is retired, never deleted.
- The `growth_*` count tables — set cardinalities per dimension tuple, unique on the
  tuple, which is the rollup's upsert target. A grain-bearing table holds hour rows and
  day rows together, because hours never sum to a day; `overflow` marks a bucket cut off
  by a set ceiling, so an aggregate over it is a floor. One table per family, because
  cardinalities do not add across dimensions; the family set is the `growth-*` schema
  modules.
- `user_acquisition` — identity-owned, one row per account: the tag its signup link
  carried, the platform, and the channel the holder named if ever asked and answered.
- Views (`schema/views/`) are Drizzle-managed, owned by the slice that reads them, and
  project no identifier; the reader role's grants ride them (`packages/db/CLAUDE.md`
  §Migrations).

## Deletion

Deletion is hard — the privacy promise. The exceptions are pseudonymized by nulling their
reference to the user, never kept whole: financial rows (GDPR Article 17(3)(b) retention),
newsletter consent evidence (the proof a subscriber opted in), `shared_links.createdBy`
(the surviving row is the record of the creator-deletion revoke), and the messages the
account sent in conversations it did not own (the surviving rows keep those threads,
forks and sequence numbers whole). Those messages also lose their content: the deletion
transaction deletes their `content_items`, stamps `messages.deletedAt`, and nulls
`messages.senderId`, which has no foreign key and so is cleared explicitly. R2 ciphertext
— of the conversations the account owned and of those messages alike — is reclaimed by
the `media.reclaimUser.v1` job, with orphan garbage collection (minimum age at least the
maximum run deadline plus margin) as the crash-debris backstop.

`account_deletion_events` is deliberately anonymous — no user FK, only deletion time, IP
and user agent, for abuse-cluster forensics — written in the same transaction that
deletes the `users` row.

`user_acquisition` goes with the account. The growth aggregates hold no identity, so
nothing deletes them; a deleted account leaves its weekly cohort's `finished` count and
never its `started` one.

A backup written before a deletion still holds the deleted row, encrypted, until the
published retention ceiling expires it. That ceiling is a legal commitment resting on
three values that cannot move independently of it: `docs/BACKUPS.md` §The retention
ceiling.
