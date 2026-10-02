/**
 * Single source of truth for the app's E2E state-signal attribute NAMES.
 *
 * A "state signal" is a `data-*` attribute the production app emits to expose
 * deterministic readiness/quiescence to tests, so specs gate on app state
 * instead of wall-clock waits. Each name maps to a real emission site in
 * `apps/web/src` / `packages/ui/src` / `apps/marketing/src`.
 *
 * This registry deliberately excludes:
 *  - `data-testid` (lives in TEST_IDS).
 *  - third-party library attributes the app does not author (e.g. Radix
 *    `data-state`, React Virtuoso `data-item-index`, vaul/sonner `data-*`).
 *  - cosmetic variant props (`data-variant`, `data-size`) that carry no
 *    readiness meaning for tests.
 *
 * Keys are camelCase; values are the literal kebab-case attribute names.
 */
export const TEST_SIGNALS = {
  // App shell — top-level "the SPA has hydrated and settled" gate.
  // Emitted: apps/web/src/routes/_app/chat.index.tsx
  appStable: 'data-app-stable',

  // The app has finished determining who is signed in and is presenting no
  // session, false while that determination is still in flight. It reports
  // what the app is presenting, not whether an account session exists: a link
  // guest viewing a share masks the session (`useSession` in
  // apps/web/src/lib/auth/auth.ts), so that page reports true while an account
  // session may still be held. Emitted on the root shell, so it is readable on
  // every route: sign-out reloads in place and the route decides where that
  // lands (a `requireAuth` route redirects to the login page, an unguarded one
  // stays put as a trial page), which makes the URL useless as a logged-out
  // discriminator.
  // Emitted: apps/web/src/routes/__root.tsx
  signedOut: 'data-signed-out',

  // Message list readiness + counts. The list publishes these so specs can
  // distinguish "no messages yet" from "decryption in flight" without racing.
  // Emitted: apps/web/src/components/chat/message-list.tsx
  messagesReady: 'data-messages-ready',
  messageCount: 'data-message-count',
  decryptedCount: 'data-decrypted-count',
  assistantCount: 'data-assistant-count',
  costCount: 'data-cost-count',
  rowsCount: 'data-rows-count',
  streamingCount: 'data-streaming-count',
  // Emitted on the message list and on the root shell
  // (apps/web/src/routes/__root.tsx): a new-chat page renders no message list,
  // so the shell is where a spec reads it before a first send.
  streamsCompleted: 'data-streams-completed',
  // Monotonic count of pre-inference stages (today the Smart Model classifier).
  preInferenceStagesSeen: 'data-pre-inference-stages-seen',
  virtuosoScrolling: 'data-virtuoso-scrolling',
  // Whether the message list is pinned at the bottom (within Virtuoso's
  // atBottomThreshold). Lets auto-scroll specs gate on settled-at-bottom state.
  atBottom: 'data-at-bottom',

  // Per-message identity/role, used to locate and count rendered messages.
  // Emitted: apps/web/src/components/chat/message-item.tsx
  messageId: 'data-message-id',
  role: 'data-role',

  // The composer's affordability producer has left its pending state: the
  // payer's funding snapshot is served, terminally unavailable, or the caller
  // holds no funding door, AND the model catalog has landed. "true"/"false",
  // always present while the composer renders. Resolved, whether by success or
  // error — the same semantics as bannerSettled and statsSettled.
  // It states a fact appStable does not: that gate spans the session and the
  // balance read, while the turn's verdict rides the payer's spendable read and
  // the catalog, and every affordability readout renders neutral until both
  // land. Neutral is the same DOM a passing assertion sees, so a spec that
  // grades a greyed option or a refused send must gate on this instead.
  // Emitted: apps/web/src/components/chat/input/prompt-input.tsx
  affordabilitySettled: 'data-affordability-settled',

  // The effort chip's slide wrapper, tri-state: "present" | "collapsing" |
  // "absent". The middle value exists because an outgoing chip keeps rendering
  // under the SAME test id until its collapse transition ends, so a
  // point-in-time visibility read can catch a chip on its way out and grade the
  // previous model's ladder.
  // Emitted: apps/web/src/components/chat/input/reasoning-effort-menu.tsx
  effortControl: 'data-effort-control',

  // The conversation's key-chain verdict, tri-state: "verified" | "pending" |
  // "bad". "pending" is a member's departure awaiting its key rotation; "bad"
  // is a rotation whose keys failed verification. A spec that asserts a
  // rotation landed gates on "verified" rather than on the epoch number alone.
  // Emitted: apps/web/src/components/chat/page/epoch-integrity-banner.tsx,
  // apps/web/src/components/chat/message/invalid-keys-notice.tsx
  epochState: 'data-epoch-state',

  // WebSocket connection lifecycle for group chat.
  // Emitted: apps/web/src/components/chat/chat-layout.tsx
  wsConnected: 'data-ws-connected',
  wsReady: 'data-ws-ready',

  // Announcement banner data fetch resolved (success or error) and the
  // show/hide decision applied — distinguishes "no banner" from "not loaded".
  // Emitted: apps/web/src/components/banner/announcement-banner.tsx,
  // apps/marketing/src/components/AnnouncementBanner.astro
  bannerSettled: 'data-banner-settled',

  // Marketing roadmap board finished loading.
  // Emitted: apps/marketing/src/components/roadmap/RoadmapBoard.tsx
  roadmapReady: 'data-roadmap-ready',

  // Marketing leaderboard stats fetch resolved (success or unavailable) —
  // distinguishes "unavailable" from "not loaded". Set to "true" on whichever
  // branch rendered.
  // Emitted: apps/marketing/src/components/stats/StatsBoard.tsx
  statsSettled: 'data-stats-settled',
  // Present only on the loaded-with-data leaderboard wrapper (never on the
  // unavailable state), so settled-without-ready means "loaded, no data".
  // Emitted: apps/marketing/src/components/stats/StatsBoard.tsx
  statsReady: 'data-stats-ready',

  // Marketing newsletter signup form hydrated and ready to accept input.
  newsletterReady: 'data-newsletter-ready',

  // Blog read-aloud control has begun speaking — audio has actually been
  // scheduled on the AudioContext (the document reader's `onAudioStart`),
  // not merely that synthesis finished or the reader entered its `speaking`
  // phase, both of which precede any audio. Absent while idle, loading
  // (downloading/warming up), paused, or errored, so a test cannot mistake
  // "download finished" for "audio playing".
  // Emitted: packages/ui/src/components/blog-reader/blog-read-aloud.tsx
  blogSpeaking: 'data-blog-speaking',

  // Chat read-aloud has begun speaking a given message — bound to the TTS
  // stream feeder's `onAudioStart` (itself the engine's own `onAudioStart`,
  // fired after `source.start()` returns), never to the earlier
  // "speakingStreamId is set" transition, which fires on the decision to
  // speak and can precede real audio by the time it takes to synthesize.
  // Per-message rather than shared with `blogSpeaking`: the blog signal
  // names a single page-level control, while chat can have many messages
  // each with their own Stop-reading button, so the signal must be scoped
  // to the message it belongs to rather than asserting one global state.
  // Emitted: apps/web/src/components/chat/indicators/tts-stop-button.tsx
  chatSpeaking: 'data-chat-speaking',
} as const;

export type TestSignalName = (typeof TEST_SIGNALS)[keyof typeof TEST_SIGNALS];
