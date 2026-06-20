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

  // Generic explicit-quiescence marker rendered by the settled-indicator.
  // Emitted: apps/web/src/components/shared/settled-indicator.tsx
  settled: 'data-settled',

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
  streamsCompleted: 'data-streams-completed',
  virtuosoScrolling: 'data-virtuoso-scrolling',
  // Whether the message list is pinned at the bottom (within Virtuoso's
  // atBottomThreshold). Lets auto-scroll specs gate on settled-at-bottom state.
  atBottom: 'data-at-bottom',

  // Per-message identity/role, used to locate and count rendered messages.
  // Emitted: apps/web/src/components/chat/message-item.tsx
  messageId: 'data-message-id',
  role: 'data-role',

  // WebSocket connection lifecycle for group chat.
  // Emitted: apps/web/src/components/chat/chat-layout.tsx
  wsConnected: 'data-ws-connected',
  wsReady: 'data-ws-ready',

  // Marketing roadmap board finished loading.
  // Emitted: apps/marketing/src/components/roadmap/RoadmapBoard.tsx
  roadmapReady: 'data-roadmap-ready',
} as const;

export type TestSignalName = (typeof TEST_SIGNALS)[keyof typeof TEST_SIGNALS];
