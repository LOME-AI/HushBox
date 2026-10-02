# Notifications

The design of record for HushBox's notification system: push (native + web), the
in-app foreground layer, and every rule that governs what may leave the server. Read
this before touching any notification, push, or service-worker code.

---

## The laws

These are doctrine, not defaults. Changing one is an architecture decision.

1. **Generic payload law.** Every push payload, notification title/body, tag, and
   push-service-visible header is content-free: a fixed per-category string plus a
   conversation deep link. Never sender names, conversation titles, message content, or
   any user-generated text. There is no on-device decryption enrichment and no iOS
   Notification Service Extension — notifications about E2E-encrypted data are generic
   by construction, not by best effort.
2. **Best-effort law.** Notification delivery is the degradable class (like email and
   telemetry, unlike money and persistence). Sends fire at the composition root via
   `waitUntil`, never inside a domain transaction, never as a `jobs` row. A dropped
   notification needs no recovery: the database and the in-app UI are the truth; push
   is a nudge toward them.
3. **Server-evaluated controls.** Whether a user is notified is decided in exactly one
   place: a pure decision function in the notifications slice domain. The client never
   re-implements "should this user be notified." The client's only say is display-point:
   a tab focused **on that conversation** suppresses the system notification, because the
   screen the user is looking at already shows what the notification would say. Any other
   focused page — a different conversation, the blog, settings — still gets it. It decides
   _whether to show_, never _whether to send_ — and a suppressed notification produces no
   in-app substitute (see the activity badge below).
4. **One lifecycle.** All delivery targets — native FCM tokens and web push
   subscriptions — live in `device_tokens`. Registration is an idempotent upsert
   predicated on ownership: a token held by another account is refused with a conflict,
   never reassigned. Dead-target detection is reactive on send (FCM `UNREGISTERED`; a
   Web Push subscription the push service reports gone or whose VAPID key it refuses →
   prune); a retention cron deletes rows stale by `lastSeenAt`; nothing else removes a
   dead target. A per-user cap (`MAX_DEVICE_TOKENS_PER_USER` in the
   device-token store) evicts the least-recently-seen rows at registration so the newest
   registration always survives — a bound on one user's fan-out width, not a cleanup
   path.

## Event categories

The closed set. A new category is a schema change plus a decision-function change plus a
settings toggle — all three, always.

| Category        | Fires when                                                                                     | Fired from                                                   |
| --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `message`       | A message is persisted in a conversation                                                       | ConversationRoom DO terminal sink; chat route (runless send) |
| `runCompletion` | A run completes successfully (never on failure — the client's own deadline UX covers failures) | ConversationRoom DO terminal sink                            |
| `membership`    | User is added to a conversation; fork/share activity involving them                            | conversations routes                                         |

Every event carries a fire-time presence snapshot from its call site; present users are
excluded. There is no live presence query from the notifications slice — the caller's
snapshot is the only presence input (the slice never queries the DO).

## Transports

| Platform                            | Transport                                      | Notes                                                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android (Capacitor)                 | FCM HTTP v1 from the Worker                    | JWT-signed OAuth via WebCrypto; no `firebase-admin`                                                                                                                                                              |
| iOS (Capacitor)                     | FCM HTTP v1 (Google relays to APNs)            | Requires the APNs→FCM token bridge (`@capacitor-community/fcm`, which coexists with `@capacitor/push-notifications`); the Worker never talks to APNs directly                                                    |
| Web (Chrome/Firefox/desktop Safari) | Web Push (RFC 8291/8188/8292) from the Worker  | In-house sender: aes128gcm payload encryption + VAPID ES256 via `jose`; no third-party push library (every candidate audited implemented the legacy `aesgcm` encoding, which Apple rejects, or was unmaintained) |
| iOS browser                         | Web Push, **installed (Home Screen) PWA only** | Platform ceiling: no iOS browser tab can receive push; the manifest exists chiefly for this                                                                                                                      |

FCM is deliberately the single mobile gateway. Direct APNs from the Worker is feasible
(ES256 p8 JWT) and was rejected to keep one mobile mechanism; it remains the recorded
option if Google must ever leave the iOS metadata path.

**Privacy asymmetry, documented:** Web Push payloads are encrypted end-to-server-to-
browser — the push services (Google/Mozilla/Apple) cannot read them. FCM payloads are
readable by Google by construction. Both carry only generic content (law 1), so the
asymmetry exposes routing metadata, not content. The collapse identity every push service
sees — the Web Push `Topic` header, the FCM `collapse_key`, the APNs collapse id — carries
a derived alias (a truncated HMAC of the conversationId under a server secret), never the
raw id; the `Topic` header is the one that matters most, since the Web Push payload beside
it is encrypted. The Android notification tag is the deliberate exception: it is the
device-local address the client clears a read conversation by, and it carries the raw id,
which the same FCM message's data payload already puts in front of Google regardless.

## The pipeline

```mermaid
flowchart LR
  SRC["Event source (DO sink / route, waitUntil)"] --> NE["notifyEvent (notifications barrel)"]
  NE --> DEC["Pure decision fn: prefs + quiet hours + mute + presence + global switch"]
  DEC --> CS["Composite PushSender"]
  CS --> FCM["FCM adapter (ios/android tokens)"]
  CS --> WP["Web Push adapter (web subscriptions)"]
  FCM & WP --> PRUNE["dead targets → prune"]
```

The decision function's inputs and their sources:

| Input           | Source                                                         | Semantics                                                                                   |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Global switch   | `notification_preferences.globalEnabled`                       | Off = nothing, ever                                                                         |
| Category toggle | `notification_preferences.{messages,runCompletion,membership}` | Per-category opt-out                                                                        |
| Quiet hours     | `quietHoursStartMinutes/EndMinutes` + `timezone` (IANA)        | Evaluated server-side in the user's zone; suppressed events are **dropped**, never deferred |
| Mute            | `conversation_members.muted` (boolean)                         | Per-conversation, manual on/off — no durations                                              |
| Presence        | Caller's fire-time snapshot                                    | Present users excluded                                                                      |
| Actor           | Event's `actorUserId`                                          | Dropped for `message` and `membership`; a `runCompletion` notifies its requester            |

A user with no `notification_preferences` row gets the defaults (everything on, no quiet
hours) — the row is created lazily on first settings write, never backfilled.

## Data model

| Table                      | Owner slice   | Notification-relevant columns                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notification_preferences` | notifications | `userId` PK, `globalEnabled`, `messages`, `runCompletion`, `membership`, `quietHoursStartMinutes`, `quietHoursEndMinutes` (both-or-neither), `timezone` (required with quiet hours)                                                                                                                                                                                |
| `device_tokens`            | notifications | `platform` (`ios`/`android`/`web`), `token` (FCM token, or the Web Push endpoint for web rows), `p256dh`/`auth` (web rows only, CHECK-enforced; validated at the registration boundary to their RFC 8291 shapes — an uncompressed P-256 point and a 16-byte secret), `lastSeenAt` (touched on registration and successful send; retention cron deletes stale rows) |
| `conversation_members`     | conversations | `muted` boolean; `lastReadSeq` (monotonic read cursor, written `GREATEST(current, new)` — naturally idempotent)                                                                                                                                                                                                                                                    |

## Subscription lifecycle

**Web:** the client subscribes only after an explicit grant (the one-time prompt or the
settings toggle — never on mount), under the VAPID public key the build carries from the
env registry.
Registration is a typed upsert keyed on the endpoint, refused when the endpoint belongs
to another account (law 4). On every authenticated app start
the client re-registers without waiting on the result (self-healing = run the one
mechanism again); what became of the attempt is the device's registration outcome, which
this section defines. A
standing subscription made under any other application-server key is released and
replaced at that point rather than re-registered: a VAPID keypair swap therefore heals on
each browser's next load with no user action — the swap procedure and what it costs are
`docs/runbooks/secrets/vapid-keypair.md`. The service worker handles `pushsubscriptionchange` by
re-subscribing under that same build-time key and asking an open client to re-register;
it reads nothing from the retired subscription, whose key may be the one a swap retired.
Logout and global-switch-off unsubscribe best-effort; the server-side prune (law 4) is
the recovery for the crash/offline case.

**Native:** Capacitor registration forwards the FCM token (on iOS, the Firebase plugin
bridges the raw APNs token to an FCM token — without that bridge iOS delivery fails,
because FCM rejects raw APNs tokens). A platform refusal to register arrives on its own
Capacitor event, never on the token event; the shell listens for it beside the token
listener and records a failed registration with no POST attempted, so a device that can
never receive a notification does not read as one that has not registered yet.

**Registration outcome (both platforms):** every registration attempt records one
outcome — not attempted, succeeded, failed and retryable, or failed and terminal — held
in memory for the session and never persisted; the settings card reads it beside the
platform permission (§Permission UX). The registration POST is a keyless mutation on the
app's query client, so the app-wide mutation policy governs it (`apps/web/CLAUDE.md`
§API calls): it re-issues a transport failure that produced no response, pauses while the
device is offline, and takes any response as final for the session. A refusal under law 4
— the endpoint or token belongs
to another account — is the terminal outcome: no later attempt in the session can change
it, and the card offers no retry for it. Every other failure is retryable, and it need
not be a POST at all: on web, no service worker, a refused push subscription, or a
subscription the client's own schema rejects records the same outcome, and on native the
platform's refusal above does. The outcome set deliberately has no reading for a
permanent platform denial — it reads as retryable, because that is nearer the truth than
a healthy reading, and a third outcome with its own copy is a product decision rather
than a fix (ruled 2026-09-14). The next authenticated app start re-registers regardless
and is the recovery for everything the in-session retry and the card's retry do not fix.
Mechanics: `apps/web/src/lib/notification-channel/`.

## Dismissal & the foreground layer

- Every push carries a per-conversation collapse identity (FCM `collapse_key`, APNs
  collapse id, Web Push `Topic` — all the derived alias), so a user holds at most one
  pending notification per conversation. The displayed notification is separately tagged
  with the raw conversationId (Android `notification.tag`, SW `showNotification` tag),
  which is how the client finds and clears it.
- `lastReadSeq` is the durable cross-device read cursor, written by an explicit client
  signal when a conversation is viewed.
- Clearing is client-side and lazy: viewing a conversation clears its delivered
  notifications on that device; on app foreground the client fetches read state and
  clears notifications for conversations read elsewhere. **Cross-device dismissal is
  eventual (next foreground), not instant** — remote-clear pushes were rejected because
  iOS throttles silent pushes to the point where the mechanism cannot reliably succeed,
  and a mechanism that cannot succeed breeds banned backup mechanisms.
- The in-app foreground layer is an **activity badge**, deliberately not a durable
  unread count: a client-side store counts events observed on the open conversation's
  socket while the tab/app is unfocused, drives the tab title `(n)` prefix,
  `navigator.setAppBadge` where supported, and an opt-in sound (default off, never the
  sole signal). It resets on focus and starts at zero on a fresh session.
  Server-authoritative unread counts are a recorded future option, not a bug.
  The service worker does not feed this store: the only push it suppresses is one for the
  conversation a focused tab is already showing, which needs no signal of any kind. Every
  other push raises an OS notification, so no event is left without a signal — which is
  why no in-page hand-off from the worker exists.

| Surface             | Mechanism                                           | Support limits                                                                                         |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| System notification | SW `showNotification` / native shade                | iOS web: installed PWA only                                                                            |
| Tab title `(n)`     | Single title-writing effect (the only title writer) | Web only                                                                                               |
| App badge           | `navigator.setAppBadge`                             | No Android browser support; iOS/desktop installed contexts; `setAppBadge(0)` hides the badge on Safari |
| Sound               | Opt-in, plays on in-app arrival                     | Settings toggle is the autoplay-unlocking gesture                                                      |

## Permission UX

The OS permission dialog is **never** requested on mount. The only triggers are:

- The **one-time prompt**: a dismissible inline callout in the app chrome (not a
  modal; `role="status"`; keyboard-reachable). Enable → OS dialog → on grant, subscribe
  - register. Later → dismissed forever on that device (`localStorage` — device-local
    because browser permission itself is per-device). It never renders when permission is
    already granted or denied, when the platform has no push path, or when the global
    notifications setting is off.
- The **settings card** (`/settings` → Notifications): global switch, per-category
  toggles, quiet hours (hour-granularity start/end + auto-detected IANA timezone), and a
  reading of the device it is open on. That reading has two inputs: the platform
  permission, with a control that asks while the platform has not been asked, and this
  session's registration outcome (§Subscription lifecycle), which overrides a granted
  permission when registration failed — a retryable failure carries a control that
  re-runs registration, a terminal one does not. The card never reports a device as set
  up on permission alone. Turning the global switch on walks the same permission flow;
  turning it off unregisters.

Both platforms share one client facade (`notificationChannel`) with a web adapter
(Notification API + PushManager + SW) and a native adapter (Capacitor) — the permission
state machine exists once.

## Environment

All registry entries with values for every mode; production values are Workers secrets.

| Variable                                            | Purpose                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY`            | Web Push VAPID keypair (dev/CI use a committed throwaway pair — dev sends only ever reach the mock)                                                                                                                                                               |
| `VITE_VAPID_PUBLIC_KEY`                             | The public key, exposed to the browser for `pushManager.subscribe`                                                                                                                                                                                                |
| `VAPID_SUBJECT`                                     | VAPID `sub` claim (mailto/https)                                                                                                                                                                                                                                  |
| `NOTIFICATION_TAG_SECRET`                           | HMAC key for the per-conversation collapse alias (FCM `collapse_key`, APNs `apns-collapse-id`, Web Push `Topic`). Despite the name it does not key the Android notification tag, which carries the raw conversation id.                                           |
| `FCM_PROJECT_ID` / `FCM_SERVICE_ACCOUNT_JSON`       | Production FCM credentials; production mode only                                                                                                                                                                                                                  |
| `FCM_PROJECT_ID_CI` / `FCM_SERVICE_ACCOUNT_JSON_CI` | CI-only service account, custom IAM role holding `cloudmessaging.messages.create` alone — never the predefined admin role, never the production credential. Missing ⇒ `pnpm generate:env --mode=ciVitest` throws and the whole CI DAG fails before any test runs. |

## Development & testing

- Dev/CI bind a mock composite sender that captures every send; the notifications slice
  barrel publishes that capture (`listCapturedPushes`), and it is how a test reads back
  what was sent.
- The Web Push sender's encryption is pinned byte-exact to the RFC 8291 Appendix A test
  vector (injectable ephemeral key + salt); VAPID JWTs are verified structurally.
- Playwright covers the prompt, settings, and — via Chromium CDP push injection into the
  real service worker — delivery. Notification click and deep-link have no programmatic
  trigger in any browser or protocol (the suite's own header,
  `e2e/notifications/notifications.spec.ts`, states this), so no executing test drives
  them end to end: the click handler is exercised at unit level only, and changes on that
  path need review by reading. The Android Maestro harness covers the prompt and
  permission-grant flows on the emulator.
- The FCM **send** path runs for real in CI: a live OAuth exchange with Google plus one
  `validate_only` `messages:send`, gated by `pnpm verify:evidence --require=push-fcm`.
  It proves RS256 JWT signing, project id, scope, request shape, and error
  classification against Google — not delivery.
- The Web Push ciphertext is proven decryptable by an independent RFC 8291/8188
  implementation over randomized keys, not only against the fixed vector above.
- Deliberately untested in CI: the push-service → device hop (live Google/Mozilla/Apple
  delivery infrastructure and real devices; non-hermetic by nature). iOS device delivery
  is verified manually. The Web Push sender → push-service hop is also unproven in CI,
  as is Resend outbound delivery; both are recorded exceptions with their re-entry
  conditions in `docs/DECISIONS.md` §Recorded exceptions.

## Deliberate limits

- No jobs, queues, or retries for delivery; a missed notification is recovered by the
  UI showing the state, not by redelivery. The registration hop's bounded in-session
  retry (§Subscription lifecycle) is the one retry anywhere on the notification path,
  and it re-issues a POST that got no response, never a send.
- Quiet-hours suppression drops; it never defers or batches.
- Mute is a boolean; duration tiers were considered and rejected.
- No management of other devices — no device list, no per-device mute; push is
  all-in-or-out per user. The settings card reads and repairs only the device it is
  open on (§Permission UX).
- No marketing or announcement content ever rides the notification channel; it exists
  for the three event categories only.
- The activity badge is session-local by design (see above).
- Cross-device dismissal is eventual, bounded by next app foreground.
