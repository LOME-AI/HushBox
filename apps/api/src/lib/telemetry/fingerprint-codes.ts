import { ERROR_CODES } from '@hushbox/shared';

/**
 * The single, exhaustive registry of every `captureError` fingerprint code in
 * use. A fingerprint code groups a logical failure across call paths in Sentry
 * (`sentry-adapter` puts it in `tags.errorCode` and the fingerprint), so the
 * strings must stay stable, finite, and collision-free — a mistyped literal
 * silently fragments one failure into many groups.
 *
 * Every call site references a member of this object; nothing passes an inline
 * literal. `captureError`'s parameter is typed `FingerprintCode` (below), so an
 * unregistered or misspelled code fails to compile — the registry is both the
 * source of truth and the typo guard.
 *
 * `internal` is single-sourced from the shared wire code: the top-level error
 * handler in `app.ts` fingerprints every uncaught error as `ERROR_CODES.INTERNAL`,
 * and this entry keeps that value in the union without duplicating the literal.
 */
export const FINGERPRINT_CODES = {
  cronUnknownSchedule: 'cron_unknown_schedule',
  cronEntryFailed: 'cron_entry_failed',
  internal: ERROR_CODES.INTERNAL,
  jobPassFailed: 'job_pass_failed',
  jobDeadLetter: 'job_dead_letter',
  jobCompletionWriteFailed: 'job_completion_write_failed',
  jobsStuck: 'jobs_stuck',
  // A job type whose handler was killed at its declared execution budget. Kept
  // apart from `jobsStuck`, which is a row NOBODY is executing that the
  // dispatcher should have acted on, and from `jobDeadLetter`, which fires only
  // once a row has burned every retry — by then the type has hit the same wall
  // on every attempt its registration allowed, and the first kill, the one
  // whose cause is still fresh, went unreported. One code for the whole sweep,
  // so a type killing many rows raises one issue rather than one per row.
  jobLeaseTimeout: 'job_lease_timeout',
  mediaGcDeleteFailed: 'media_gc_delete_failed',
  workflowNodeDefect: 'workflow_node_defect',
  workflowSettlementDefect: 'workflow_settlement_defect',
  workflowRunDefect: 'workflow_run_defect',
  workflowCostCircuitTripped: 'workflow_cost_circuit_tripped',
  // An unreachable dependency killed a run. The wire code tells the user the
  // system is down; nothing in it tells an operator WHICH dependency, and the
  // warn beside it goes to an adapter nothing retains — so this is the only
  // channel that signal survives on. One code for the whole class, so an outage
  // groups into a single issue instead of one per run it killed.
  workflowInfraUnavailable: 'workflow_infra_unavailable',
  // Provider spend the platform absorbs rather than bills: a node's value was
  // rejected after its call was paid for. Kept apart from the cost circuit's
  // code because each names a different repair: a circuit closing means the
  // admission estimate was exceeded K-fold, a rejection means a model or a
  // schema is producing output we cannot accept.
  workflowRejectedOutputAbsorbed: 'workflow_rejected_output_absorbed',
  // The loss class `workflowRejectedOutputAbsorbed` belongs to, reached when a
  // settlement refusal finds nobody to bill: the payer's account was deleted
  // while the run streamed, so the answer the client already received is
  // absorbed. Kept apart from that code because it names no repair of ours: its
  // figure is what account deletion mid-run costs, and a pattern of it is the
  // abuse signal.
  workflowRefusalAbsorbed: 'workflow_refusal_absorbed',
  // A validated-DAG invariant breaking inline, which the exception-escape codes
  // (`workflowNodeDefect`, `workflowSettlementDefect`, `workflowRunDefect`)
  // cannot carry because nothing throws. Kept apart by who repairs each: a
  // malformed admission grant is the admission hook's, a predicate returning
  // outside its declared type is the registered implementation's, and naming an
  // implementation the registry does not hold is the wiring's.
  workflowAdmissionGrantMalformed: 'workflow_admission_grant_malformed',
  workflowPredicateContractBroken: 'workflow_predicate_contract_broken',
  workflowUnregisteredImplementation: 'workflow_unregistered_implementation',
  inferenceProviderCostUnavailable: 'inference_provider_cost_unavailable',
  // A users row whose sealed OPAQUE material names a KEK this deployment does
  // not hold: the key and the rows disagree. The user sees only INTERNAL, so
  // this is the one channel that says what to repair (a re-seal, or the
  // offline copy of the key the rows were sealed under).
  opaqueServerMaterialUnreadable: 'opaque_server_material_unreadable',
  // A stored TOTP secret sealed under a TOTP key this deployment does not
  // hold. Every 2FA gate refuses that user until an admin clears the stranded
  // second factor, and the state can only follow a key swap whose re-seal was
  // skipped or partial — so the first event is also evidence the swap's
  // procedure was not followed. One code across the gates, so repeats from
  // one user collapse into one issue rather than one per gate reached.
  totpSecretStranded: 'totp_secret_stranded',
  // The catalog pages on an aggregate consequence, never on a per-item one: a
  // per-model exclusion and a truncated gateway list stay warn-only by standing
  // founder ruling (reasoning at the exclusion classifier in
  // `apps/api/src/slices/models/domain/catalog/refresh.ts`) — the OpenRouter taxonomy
  // grows shapes we don't price, so paging on each every hour is noise. Having
  // nothing left to sell is not noise, and a row we wrote ourselves failing to
  // read back is a defect in our own data rather than upstream drift.
  modelCatalogRetentionListEmpty: 'model_catalog_retention_list_empty',
  modelCatalogMassExclusion: 'model_catalog_mass_exclusion',
  modelProjectionInvalid: 'model_projection_invalid',
  modelDescriptorInvalid: 'model_descriptor_invalid',
  modelFamilyUnclassifiable: 'model_family_unclassifiable',
  trialDailyCapCrossed: 'trial_daily_cap_crossed',
  adminEphemeralEffectFailed: 'admin_ephemeral_effect_failed',
  adminOpNotificationFailed: 'admin_op_notification_failed',
  // A role refused: the route-roles map or an operation contract did not list
  // the authenticated actor's role. Nothing durable records it — a refusal is
  // an act that did not happen, and the audit trail holds acts — so this is
  // the only retained channel a viewer probing the plane, or a route that
  // shipped with no declaration, reaches an operator on.
  adminRoleRefused: 'admin_role_refused',
  adminAccessEnrollmentEvent: 'admin_access_enrollment_event',
  adminAccessUnexpectedActor: 'admin_access_unexpected_actor',
  adminAccessLogPageLimit: 'admin_access_log_page_limit',
  ledgerConservationUnbalanced: 'ledger_conservation_unbalanced',
  ledgerWalletBalanceDrift: 'ledger_wallet_balance_drift',
  walletSnapshotAuditFailed: 'wallet_snapshot_audit_failed',
  walletSnapshotSeqAhead: 'wallet_snapshot_seq_ahead',
  walletSnapshotDrift: 'wallet_snapshot_drift',
  paymentClawbackPosted: 'payment_clawback_posted',
  paymentDisputeSurfaced: 'payment_dispute_surfaced',
  // The webhook dispositions where money moved and no account can carry it: a
  // chargeback against a transaction we hold no row for, one against an account
  // already deleted, and funds captured with no wallet to credit. They stay
  // three groups because each is a separate repair. The dispositions whose
  // mechanism worked as designed — an idempotent clawback replay, a decline for
  // a payment we never had — stay warn-only and register nothing.
  paymentDisputeUnmatched: 'payment_dispute_unmatched',
  paymentDisputeOrphaned: 'payment_dispute_orphaned',
  paymentCompletedWithoutWallet: 'payment_completed_without_wallet',
  // A `payments` row still non-terminal after the verify job's whole retry
  // ride-out — the only channel a stranded charge has. A dead-lettered verify
  // job is neither `pending` nor `running`, so `jobsStuck` cannot see it, and
  // `awaiting_webhook` means the card was captured: a card charged and never
  // credited would otherwise sit silent forever. One code for the whole pass,
  // so a vendor outage that strands many rows raises one issue, not one per
  // row; the rows themselves are read out of the database it points at.
  paymentUnresolvedPastVerifyWindow: 'payment_unresolved_past_verify_window',
  // A push fan-out every target rejected. Push is best-effort and per-target
  // failures never page — this is the aggregate consequence instead: the shape
  // a revoked service account or a push-service outage takes, which the sender
  // otherwise reports as success. A send with a single rejected target stays
  // log-only, because one target failing is indistinguishable from one flaky
  // device.
  pushDeliveryTotalFailure: 'push_delivery_total_failure',
  // A route's declared bound could not be spent, so the pipeline admitted a
  // request it could not bound. The route declared `open`, which is the only
  // way a request reaches this event — a route declaring `closed` refuses the
  // same input and admits nothing — and the route is named by the
  // `rateLimitRoute` tag, a class-default route and a named-limit route alike.
  // Where the spend stopped is the `rateLimitBypassCause` tag: `counter` when
  // the counter answered no decision, `identity` when the value it would have
  // been keyed on could not be resolved and the counter was never asked —
  // different systems to look at, so read the tag before reaching for the
  // counter store. It is registered because the fail-open half of the
  // rate-limit doctrine promises a bypass is alerted, and this channel is the
  // only one a promise like that can be kept on: the log line beside it goes to
  // an adapter nothing ingests. What one event stands for is stated where it is
  // raised (`apps/api/src/middleware/pipeline-rate-limit.ts`) — it is a lower
  // bound on the bypass, never a count of it.
  rateLimitBypassed: 'rate_limit_bypassed',
  // A request was refused because a dependency did not produce a usable answer:
  // an availability refusal (503 or 504) from any route or pipeline stage, the
  // rate-limit counter's fail-closed refusal among them. The wire code names no
  // dependency, so this is the only channel the name survives on. Which
  // dependency, which failure arm, whether the isolate's own event loop was
  // late, and the route are the `dependency`, `dependencyFailure`,
  // `dependencyLate` and `dependencyRoute` tags — read the arm and the lateness
  // before reaching for a system, because a slow store, a request overlapping
  // its own statements on a serial pool (`serial-overlap`, a code defect and
  // not an outage), and a stalled isolate are different repairs.
  // A `dependency` of `unknown` names a cause the classifier has no reading
  // for. What one event stands for is stated where it is raised
  // (`apps/api/src/lib/context/domain-error-status.ts`) — a lower bound on the
  // refusals, never a count of them.
  dependencyUnavailable: 'dependency_unavailable',
  // The backup repository's newest snapshot is older than the tolerance, or the
  // repository holds no snapshot at all. The backup runs outside this Worker on
  // a schedule GitHub cannot alert on when it stops firing, so a cron auditor
  // reading the repository is the only channel a silent stop surfaces on. One
  // code for both shapes: an empty repository and a stalled one name the same
  // repair, which is running the backup workflow and finding out why it stopped.
  backupStale: 'backup_stale',
  // The B2 lifecycle rule over the repository prefix is absent, or its
  // noncurrent-version expiry is not the promised number of days. That rule is
  // the only stage of the deletion chain that destroys data — the backup key
  // holds no destroy capability, so a delete only hides a version — which makes
  // this the sole check standing behind the retention ceiling the privacy policy
  // publishes. Nothing else in the system can observe the rule.
  backupLifecycleDrift: 'backup_lifecycle_drift',
  // The auditor could not read the repository at all: the store refused, timed
  // out, or answered something unparseable. Kept apart from the two findings
  // above because it is the absence of an answer rather than a bad one — an
  // auditor that cannot see is not an auditor reporting all-clear, and without
  // this code a credential expiry would look exactly like a healthy repository.
  backupAuditUnavailable: 'backup_audit_unavailable',
  // A version hidden in the backup bucket is still there long after the
  // lifecycle rule should have destroyed it. Kept apart from
  // `backupLifecycleDrift` because the two want different repairs: that one
  // says the rule STATES the wrong duration, this one says versions are not
  // being erased whatever the rule states — a retention lock set on the bucket
  // from the vendor console, a rule that silently stopped applying, or a vendor
  // sweep that stalled. A lock in particular is invisible to every other check:
  // snapshots stay fresh and the rule still reads back correct while nothing is
  // erased, so this code is the only channel it surfaces on. What is measured
  // is the effect rather than the configuration, because reading the lock needs
  // a vendor capability the auditor's credential deliberately does not hold.
  backupRetentionOverdue: 'backup_retention_overdue',
  // The retention check ran out of listing budget before it reached the end of
  // the repository, so it covered part of the bucket and can say nothing about
  // the rest. Kept apart from `backupAuditUnavailable`, which is a store that
  // would not answer: this one answered, and the repair is the auditor's own
  // page budget or an incremental scan rather than anything about the store.
  // It is registered rather than silent because a check that quietly stops
  // looking reports all-clear over exactly the repository it failed to scan.
  backupRetentionUnscanned: 'backup_retention_unscanned',
  // A marketing beacon reached a Redis that could not answer, so that request's
  // counts are lost. The route answers the marketing page normally either way —
  // a counter outage must never break a page — so this is the only channel the
  // loss surfaces on at all. One code for the whole class, so an outage groups
  // into a single issue rather than one per beacon it dropped; what it stands
  // for is a lower bound on the loss, never a count of it.
  growthCounterUnavailable: 'growth_counter_unavailable',
  // A growth set reached its per-bucket member ceiling and refused a member, so
  // that bucket's count for that dimension is a floor rather than a total. It
  // fires once per set per bucket, latched by the overflow flag the rollup then
  // copies onto the row, so the dashboard says so too. Reaching it at all is
  // either a traffic level nobody planned for or an inflation attempt, and the
  // repair differs — which is why it pages rather than joining a digest.
  //
  // WHICH SETS IT SPEAKS FOR IS DERIVED, not chosen: each raiser reads the
  // refusals its own write reports back to the request that caused them, so
  // this code covers exactly the sets those writes touch. Two raise it — the
  // beacon route, and the registration start, whose counting script answers
  // whether this call was the one that latched. Both file their flags on the
  // same bucket hash, and `HSETNX` is what makes the raise happen once per set
  // per bucket: a sustained attempt on the registration set is one event an
  // hour per campaign tag rather than one per refused address.
  growthSetOverflowed: 'growth_set_overflowed',
  // One address reached its daily ceiling on distinct visitor identities. The
  // beacon that FILLS the budget raises it, and so does a refusal that meets a
  // full budget nothing has reported yet; while the budget stands, a beacon
  // from that address under an identity it had not already minted is dropped
  // and counted nowhere. Kept apart from `growthSetOverflowed` by what an
  // operator does about it: that one says a dimension's count is a floor and
  // the dashboard already says so, this one says one address has taken a whole
  // day's identity budget and nobody new behind it is counted while it stands.
  //
  // The accepted false positive, to rule out first: a large shared egress — an
  // office, a campus, a mobile carrier gateway — can reach the budget honestly,
  // because the identity is a hash over the address AND the user agent, and
  // such a sender really does put that many distinct user agents behind one
  // address. Telling that apart from a sender minting identities is the
  // judgement this event asks for. It is written here rather than into the
  // raised error because the error's message never leaves the process: the
  // Telemetry port forbids serializing it, the Sentry scrub rebuilds each event
  // from an allowlist and re-derives exceptions as type and stack, and platform
  // log retention is off — the code, the error's type and a stack are all an
  // operator is handed.
  //
  // It fires once per address per day, latched in the store, because a Worker
  // holds no memory between requests and the throttle's whole allowance would
  // otherwise arrive as Sentry events.
  growthVisitorMintCapped: 'growth_visitor_mint_capped',
  // The funnel's registration-start count could not be written, so that
  // start is missing from the hour it belongs to. Kept apart from
  // `growthCounterUnavailable` by who is looking and what they would do: that
  // one says marketing beacons are being dropped on the anonymous half, this
  // one says the identified half's funnel undercounts its first step while the
  // signup itself succeeded. The count is best-effort and the caller sees a
  // normal handshake either way, so this is the only channel the loss surfaces
  // on; it is a lower bound on the loss, never a count of it.
  growthRegistrationStartUnavailable: 'growth_registration_start_unavailable',
  // A re-roll read a visitor count below the landing count the row already
  // held, so the stored count was brought back inside the row's own
  // landings-within-visitors check. The reading can only be lower because the
  // counting store lost members the rows outlived — an eviction, a failover, a
  // flush — and nothing else in the system observes that: the sets are the only
  // record of what they held, and a set that is gone is indistinguishable from
  // one that was always empty. Kept apart from `growthSetOverflowed`, which is
  // a set that refused a member and marks its own row a floor: this is a count
  // already written that the store can no longer support, and the repair is the
  // store rather than the traffic. One event per lowered row, because the row
  // is what an operator reads and the grain, bucket and path that name it are
  // the tags the event carries.
  growthLandingCountClamped: 'growth_landing_count_clamped',
  // The web-search backend failed in a way an operator must act on. A failed
  // search reaches the model as a tool error and the turn still succeeds, so
  // without these a search that fails every time is invisible. Three codes
  // because each names a different repair: `auth` a replacement key, `quota`
  // credit on the same account. `unavailable` names one of two: a vendor outage
  // to wait out (a 5xx, a timeout, a dropped connection), or a change to our
  // request or to our reading of Brave's response (any other refused status, an
  // unparseable body). The event's HTTP status tells the two apart: a 5xx or
  // none is an outage, anything else is ours to change. A rate limit and a
  // caller's cancellation are neither, and raise nothing.
  searchProviderAuth: 'search_provider_auth',
  searchProviderQuota: 'search_provider_quota',
  searchProviderUnavailable: 'search_provider_unavailable',
  // A search result payload, or a stored search row, larger than the bound the
  // admission hold reserves for; either way the charge stays correct and the
  // bound needs revisiting. A payload is returned to the user whole and its
  // event carries its size. A row has had sources dropped to fit, and its event
  // reports the dropped sources. Sizes and counts only.
  searchResultOversize: 'search_result_oversize',
  searchRowOversize: 'search_row_oversize',
  // A member's recovery rotation superseded an epoch whose keys did not verify:
  // someone published a rotation the other members cannot open. The server
  // holds no key and cannot judge a rotation itself, so its acceptance of the
  // recovery is the report, and this is its only retained channel. One event
  // per accepted recovery, and another each time a replayed Idempotency-Key
  // repeats the route's post-commit tail; the conversation and the two epoch
  // numbers ride on the error, identifiers only.
  epochRotationSuperseded: 'epoch_rotation_superseded',
} as const;

/** The union of every registered fingerprint code — `captureError`'s parameter type. */
export type FingerprintCode = (typeof FINGERPRINT_CODES)[keyof typeof FINGERPRINT_CODES];
