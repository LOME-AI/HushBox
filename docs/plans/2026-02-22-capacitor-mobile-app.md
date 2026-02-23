# Capacitor Mobile App Integration Plan

## Context

HushBox is a React 19 + Vite SPA (`apps/web/`) backed by a Hono API on Cloudflare Workers (`apps/api/`). This plan adds Capacitor to produce native iOS and Android apps with complete web parity, targeting Apple App Store, Google Play Store, and Obtainium (GitHub Releases APK for sideloaders). Key concerns: cookie-based auth in native WebViews, payment compliance (disable in-app payment on App Store/Play Store, redirect to web), push notification infrastructure via FCM unified path, OTA live updates via Capgo, and a React-driven native asset generation pipeline.

---

## 1. Non-Code Tasks (Manual / App Store Eligibility)

- [ ] **Apple Developer Account** — Enroll ($99/year). Needed for APNs key, App Store submission, Team ID for universal links
- [ ] **Google Play Developer Account** — Register ($25 one-time). Needed for FCM, Play Store submission
- [ ] **APNs Key** — Create an APNs authentication key in Apple Developer portal. Download the `.p8` file, note Key ID + Team ID. Upload to Firebase project settings (FCM proxies to APNs)
- [ ] **Firebase Project** — Create for FCM. Download `google-services.json`. Upload APNs `.p8` key so FCM can proxy iOS push
- [ ] **App Store Privacy Questionnaire** — Complete during App Store Connect submission (no tracking, no data sharing, encrypted message storage)
- [ ] **AASA Hosting** — Ensure `https://hushbox.ai/.well-known/apple-app-site-association` serves with `Content-Type: application/json`, no redirects
- [ ] **Asset Links Hosting** — Ensure `https://hushbox.ai/.well-known/assetlinks.json` serves correctly
- [ ] **R2 Bucket** — Create `hushbox-app-builds` bucket in Cloudflare dashboard
- [ ] **Code Signing** — iOS distribution certificate + provisioning profiles, Android release keystore
- [ ] **Store Listings** — Descriptions, categories for App Store and Play Store (screenshots auto-generated — see Section 9)

---

## 2. Capacitor Setup

### 2.1 Dependencies in `apps/web/package.json`

- `@capacitor/core` (dependency)
- `@capacitor/cli` (devDependency)

### 2.2 `apps/web/capacitor.config.ts`

```typescript
const config: CapacitorConfig = {
  appId: 'ai.hushbox.app',
  appName: 'HushBox',
  webDir: 'dist',
  plugins: {
    CapacitorCookies: { enabled: true },
    CapacitorHttp: { enabled: false },
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#000000',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};
```

### 2.3 Add Platforms

```bash
cd apps/web && npx cap add ios && npx cap add android
```

Creates `apps/web/ios/` and `apps/web/android/` — committed to git (contain Info.plist, AndroidManifest.xml).

### 2.4 Scripts in `apps/web/package.json`

```json
"cap:sync": "cap sync",
"cap:build:ios": "vite build && pnpm asset:generate && cap sync ios",
"cap:build:android": "vite build && pnpm asset:generate && cap sync android",
"cap:open:ios": "cap open ios",
"cap:open:android": "cap open android"
```

### 2.5 `.gitignore` additions

```
apps/web/ios/App/Pods/
apps/web/android/.gradle/
apps/web/android/app/build/
apps/web/public/dev-assets/
apps/web/resources/generated/
```

---

## 3. Capacitor Plugins — Final List

| Plugin                          | Purpose                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@capacitor/app`                | Lifecycle events (foreground/background), deep link handling via `appUrlOpen`, Android back button |
| `@capacitor/splash-screen`      | Native launch screen, controlled hide after app init                                               |
| `@capacitor/status-bar`         | Match status bar style to dark/light theme                                                         |
| `@capacitor/network`            | Online/offline detection for WebSocket/SSE reconnection + offline overlay                          |
| `@capacitor/browser`            | Open system browser for "Manage Balance Online" + legal pages                                      |
| `@capacitor/push-notifications` | FCM token registration (Android + iOS via FCM proxy), notification handling                        |
| `@capgo/capacitor-updater`      | OTA live updates — download and apply new bundles from R2                                          |
| `@capacitor/assets`             | (devDependency) Generate all icon/splash sizes from source PNGs                                    |

**Not included**: `@capacitor/keyboard` (out of scope), `@capacitor/haptics`, `@capacitor/camera`, `@capacitor/filesystem`, `@capacitor/share`, `@capacitor/preferences`.

---

## 4. Platform Detection

### 4.1 Build-Time Platform Variable

Values: `web` | `ios` | `android` | `android-direct`

- `web` — Browser (payments enabled)
- `ios` — Apple App Store (payments disabled)
- `android` — Google Play Store (payments disabled)
- `android-direct` — Obtainium / GitHub Release APK (payments enabled)

**File**: `packages/shared/src/env.config.ts` — add `VITE_PLATFORM` with default `web`.

### 4.2 Frontend Platform Utilities

**New file**: `apps/web/src/capacitor/platform.ts`

```typescript
export type Platform = 'web' | 'ios' | 'android' | 'android-direct';

export function getPlatform(): Platform { ... }
export function isNative(): boolean { ... }
export function isPaymentDisabled(): boolean {
  const p = getPlatform();
  return p === 'ios' || p === 'android'; // NOT web, NOT android-direct
}
```

Also export `isPaymentDisabledPlatform()` from `packages/shared/src/platform.ts` (pure function, no Capacitor dependency) for backend use.

### 4.3 Backend Platform Detection via Header

**Modified**: `apps/web/src/lib/api-client.ts` — add `X-HushBox-Platform` and `X-App-Version` headers.

**New**: `apps/api/src/middleware/platform.ts` — reads `X-HushBox-Platform` header, sets `c.set('platform', ...)`. Applied globally in `app.ts`.

**Modified**: `apps/api/src/types.ts` — add `platform: Platform` to `Variables`.

> Security note: This header is client-provided and informational. Never trust it for security-critical decisions.

---

## 5. Cookie Auth in Native WebViews

**Problem**: Iron-session cookies (`sameSite`, `httpOnly`, `secure`) won't be sent cross-origin from Capacitor WebView (`capacitor://localhost` / `http://localhost`) to `https://api.hushbox.ai`.

**Fix**: `CapacitorCookies: { enabled: true }` patches the native cookie store. Backend must also cooperate:

### 5.1 Session Cookie — `sameSite: 'none'` + `secure: true` Globally

Set `sameSite: 'none'` and `secure: true` on the iron-session cookie for ALL requests (web and native). No per-origin branching.

This is safe because the CSRF middleware (Origin header validation) is the primary cross-site protection. `sameSite` is defense-in-depth — relaxing it to `'none'` doesn't reduce actual security when CSRF is enforced. Browsers treat `localhost` as a secure context even over HTTP, so development works.

**Modified**: `apps/api/src/lib/session.ts` (or wherever `getSessionOptions()` is defined).

### 5.2 CORS — `apps/api/src/middleware/cors.ts`

Add Capacitor origins to allowed list:

```typescript
origins.push('capacitor://localhost', 'http://localhost');
```

### 5.3 CSRF — `apps/api/src/middleware/csrf.ts`

Add Capacitor origins to allowed set:

```typescript
allowedOrigins.add('capacitor://localhost');
allowedOrigins.add('http://localhost');
```

---

## 6. Push Notifications — Full Backend Infrastructure (FCM Unified Path)

FCM serves as the unified sending path for both Android and iOS. FCM proxies to APNs for iOS delivery. One API, one error handling path. The APNs `.p8` key is uploaded to Firebase project settings (not used directly by our backend).

### 6.1 Database Schema

**New file**: `packages/db/src/schema/device-tokens.ts`

```typescript
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()), // PG18 native uuidv7
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    platform: text('platform').notNull(), // 'ios' | 'android'
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index('device_tokens_user_id_idx').on(table.userId),
  })
);
```

### 6.2 Mute Notifications — Schema Change (Approved)

**Modified**: `packages/db/src/schema/conversation-members.ts` — add column:

```typescript
muted: boolean('muted').default(false).notNull(),
```

New migration. UI: three-dot menu on conversation → "Mute Notifications" / "Unmute Notifications". Calls `PATCH /api/members/:conversationId/mute` with `{ muted: true | false }`.

### 6.3 API Endpoints

**New route**: `apps/api/src/routes/device-tokens.ts`

- `POST /api/device-tokens` — Register token (upsert by token, associate with userId)
- `DELETE /api/device-tokens/:token` — Unregister on logout

Middleware: `csrfProtection`, `dbMiddleware`, `redisMiddleware`, `ironSessionMiddleware`, `sessionMiddleware`.

### 6.4 Push Sending Service

**New file**: `apps/api/src/services/push/push-service.ts`

Factory pattern (matches existing email service pattern):

- **FcmPushClient** — Uses FCM HTTP v1 REST API (direct `fetch()`, no `firebase-admin` SDK — too heavy for Workers). Sends to both Android and iOS (FCM proxies to APNs).
- **MockPushClient** — Logs to console (local dev)

```typescript
interface PushService {
  send(params: {
    tokens: string[];
    title: string;
    body: string;
    data?: Record<string, string>;
  }): Promise<void>;
}
```

### 6.5 Environment Variables (Secrets)

- `FCM_PROJECT_ID` — Firebase project ID
- `FCM_SERVICE_ACCOUNT_JSON` — base64-encoded service account (for FCM HTTP v1 auth)

Added to `wrangler.toml` (secret refs) and `.dev.vars` (local mock values).

### 6.6 Push Triggers

On new message stored in a conversation (AI response OR user message in group chats):

1. Query all conversation members except the sender
2. Filter out members where `muted = true`
3. Query `deviceTokens` for remaining members
4. Fire-and-forget push via FCM

Notification payload includes `conversationId` + message preview.

### 6.7 Frontend Plugin Integration

**New file**: `apps/web/src/capacitor/hooks/use-push-notifications.ts`

- On startup (if native): request permission, register with FCM
- On token received: `POST /api/device-tokens`
- On notification tap: parse payload, navigate with TanStack Router
- On logout: `DELETE /api/device-tokens/:token`

---

## 7. Capacitor Hooks & Provider — Split Architecture

All Capacitor code in one directory: `apps/web/src/capacitor/`

```
apps/web/src/capacitor/
├── hooks/
│   ├── use-push-notifications.ts + test
│   ├── use-network-status.ts + test      # online/offline → Zustand store
│   ├── use-deep-links.ts + test          # appUrlOpen → router.navigate
│   ├── use-app-lifecycle.ts + test       # resume → reconnect WS, pause → disconnect
│   ├── use-back-button.ts + test         # Android back → history.back / exitApp
│   ├── use-splash-screen.ts + test       # hide after StabilityProvider settles
│   └── use-status-bar.ts + test          # called from ThemeProvider on theme change
├── provider.tsx + test                    # Thin shell — calls hooks, renders children
├── platform.ts + test                    # getPlatform(), isNative(), isPaymentDisabled()
├── browser.ts + test                     # openExternalUrl() utility
├── live-update.ts + test                 # Capgo startup check + 426 handling
└── index.ts                              # Barrel exports
```

Each hook guards with `if (!Capacitor.isNativePlatform()) return` internally. Each has its own test file.

### Provider Placement in `__root.tsx`

```
<ThemeProvider>          ← useStatusBar() called here on theme change
  <CapacitorProvider>    ← thin shell, calls all other hooks
    <QueryProvider>
      <StabilityProvider>
        <Outlet />
        <UpgradeRequiredModal />
        <OfflineOverlay />
      </StabilityProvider>
    </QueryProvider>
  </CapacitorProvider>
</ThemeProvider>
```

### Status Bar (via ThemeProvider)

**Modified**: `apps/web/src/providers/theme-provider.tsx` — call `useStatusBar()` hook.

iOS: set content style only (Dark = light icons, Light = dark icons). Background is transparent, app handles it via `viewport-fit=cover`.
Android: set both content style AND background color (`#000000` dark / `#ffffff` light).

### Splash Screen

Hide after `StabilityProvider` settles (core queries loaded). Config `launchAutoHide: false` ensures we control timing.

### Network Status + Offline Overlay

**New**: `apps/web/src/components/shared/offline-overlay.tsx` — full-screen "You're offline" overlay. Auto-dismisses when network returns.

**New**: `apps/web/src/stores/network.ts` — Zustand store with `isOffline` flag, set by `useNetworkStatus()`.

**Modified**: `apps/web/src/lib/ws-client.ts` — network-aware reconnection:

- On network loss: stop reconnect attempts
- On network restore: reconnect immediately (skip backoff)

### Android Back Button

`useBackButton()` — listens for `backButton` event from `@capacitor/app`:

- `canGoBack` true → `window.history.back()`
- `canGoBack` false → `App.exitApp()`

---

## 8. Payment Remodeling

### 8.1 Platform-Conditional Billing Page

**Modified**: `apps/web/src/routes/_app/billing.tsx`

On `ios` / `android` (`isPaymentDisabled()` true):

- Replace "Add Credits" button with "Manage Balance Online"
- Hide `PaymentModal` entirely
- Balance display and transaction history unchanged

On `web` / `android-direct`: no change — Helcim payment works normally.

### 8.2 "Manage Balance Online" Button

**New**: `apps/web/src/components/billing/manage-online-button.tsx`

1. Call `POST /api/billing/login-link` (authenticated)
2. Server generates random token, stores `{ userId }` in Redis with 60s TTL
3. Server returns `{ token }`
4. App calls `Browser.open({ url: 'https://hushbox.ai/billing?token=TOKEN' })` — opens **system browser**

### 8.3 Login Link API Endpoint

**Modified**: `apps/api/src/routes/billing.ts` — add `POST /login-link`

Redis key in `apps/api/src/lib/redis-registry.ts`:

```typescript
billingLoginToken: defineKey({
  schema: z.object({ userId: z.string() }),
  ttl: 60,
  buildKey: (token: string) => `billing:login-token:${token}`,
}),
```

### 8.4 Token Redemption — Billing-Scoped Session

**New route**: `apps/api/src/routes/token-login.ts`

- `POST /api/auth/token-login` — accepts `{ token }`, redeems from Redis (one-time use), creates billing-scoped session
- Session flag: `billingOnly: true`
- Bypasses OPAQUE + 2FA (acceptable: originating mobile session already passed full auth, 60s one-time-use token)
- No encryption keys (user can only access billing, not encrypted messages)

**Modified**: `apps/api/src/middleware/dependencies.ts` — if `session.billingOnly === true` and route is NOT `/api/billing/*` or `/api/auth/*`, reject with 403 `ERROR_CODE_BILLING_SESSION_RESTRICTED`.

Middleware chain for token-login: `dbMiddleware`, `redisMiddleware`, `ironSessionMiddleware` (no CSRF, no session — it creates one).

### 8.5 Web Billing Page — Token Handling

**Modified**: `apps/web/src/routes/_app/billing.tsx`

Add `validateSearch` for `?token=` query param. In `beforeLoad`: if token present, call `POST /api/auth/token-login`, remove token from URL on success, then `requireAuth()`.

### 8.6 Welcome Email — Sent on Registration (All Users)

**New**: `apps/api/src/services/email/templates/welcome.ts`

Sent to ALL new users (web and mobile) during signup flow. Content:

- Welcome to HushBox
- **How billing works**: Pay-as-you-go, no subscriptions, 15% transparent fee (5% HushBox, 4.5% card processing, 5.5% AI provider overhead)
- **How to add credits**: Visit Billing page, add credits with any card, credits never expire
- **For Apple & Google Play users**: "Tap 'Manage Balance Online' to add credits through our website. We route you to the web to avoid passing high in-app processing fees on to you — keeping your costs low."
- Positioned as: transparent, fair, looking out for the user

No per-message Redis checks. Triggered once during registration.

### 8.7 New Error Codes

Add to `packages/shared/src/schemas/api/error.ts`:

- `ERROR_CODE_UPGRADE_REQUIRED`
- `ERROR_CODE_LOGIN_TOKEN_INVALID`
- `ERROR_CODE_BILLING_SESSION_RESTRICTED`

Add friendly messages to `packages/shared/src/error-messages.ts`.

---

## 9. React-Driven Native Asset Generation

All native assets (icons, splash screens, store screenshots) are defined as React components, rendered to PNGs by Playwright (already a project dependency), and fed to `@capacitor/assets generate`. Assets auto-regenerate during `pnpm dev` on file change.

### 9.1 Directory Structure

```
apps/web/src/components/native-assets/
├── app-icon.tsx                 # 1024x1024 — Logo on solid dark background
├── icon-foreground.tsx          # 1024x1024 — Logo in center 66% safe zone (Android adaptive)
├── icon-background.tsx          # 1024x1024 — Solid dark or brand gradient
├── splash-light.tsx             # 2732x2732 — Logo + CipherWall at 40% opacity (light)
├── splash-dark.tsx              # 2732x2732 — Logo + CipherWall at 40% opacity (dark)
└── store-screenshots/           # Screenshots of the running app (see 9.5)

apps/web/src/routes/_dev/
├── assets.tsx                   # Dev preview page — shows generated PNGs in grid
├── assets.render.$name.tsx      # Render route — mounts single asset at full size for Playwright
└── emails.tsx                   # Email preview page (migrated from scripts/email-preview.ts)

apps/web/resources/
└── generated/                   # .gitignored — PNGs output by Playwright
    ├── icon-only.png
    ├── icon-foreground.png
    ├── icon-background.png
    ├── splash.png
    ├── splash-dark.png
    └── screenshots/
        ├── chat-streaming.png
        ├── model-picker.png
        └── ...

apps/web/public/dev-assets/      # .gitignored — copy of generated/ for Vite static serving
```

### 9.2 Render Routes (Internal, for Playwright)

`/dev/assets/render/:name` — mounts a single asset component at its exact target dimensions with no chrome (no sidebar, no navigation). Example: navigating to `/dev/assets/render/app-icon` renders `app-icon.tsx` at 1024x1024 viewport. Playwright screenshots these.

### 9.3 Asset Component Design

| Asset                   | Design                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App Icon**            | `<Logo />` from `@hushbox/ui`, centered on `#0a0a0a` solid background. No text — must be recognizable at 29x29                                                                                                                                                   |
| **Adaptive Foreground** | Same logo, padded to center 66% for Android mask safe zone                                                                                                                                                                                                       |
| **Adaptive Background** | `#0a0a0a` solid, or brand gradient (reuse `@keyframes shine` from `app.css`)                                                                                                                                                                                     |
| **Splash Light**        | `<Logo />` centered. CipherWall grid at 40% opacity behind it — using constants from `cipher-wall-engine.ts` (`CELL_WIDTH`, `CELL_HEIGHT`, `FONT_SIZE`, `CIPHER_CHARS`). 4 value phrases pre-placed in "readable" state (brand red `#ec4755`). Light background. |
| **Splash Dark**         | Same as light but on `#0a0a0a` background                                                                                                                                                                                                                        |

**Splash screen phrases** (deterministic, chosen from the CipherWall's existing 16):

1. "Encrypted By Default" — privacy
2. "Every Model, One Place" — aggregation
3. "No Subscriptions Required" — pricing
4. "Switch Models Anytime" — flexibility

Components import `CIPHER_CHARS`, `CELL_WIDTH`, `CELL_HEIGHT`, `FONT_SIZE` from `cipher-wall-engine.ts` — reusing, not reimplementing.

### 9.4 Auto-Generation During `pnpm dev`

**Modified**: `scripts/dev.ts` — add asset watcher as parallel process:

1. **Initial generation**: On `pnpm dev` startup, run Playwright to screenshot all asset components → save PNGs to `resources/generated/` → copy to `public/dev-assets/`
2. **File watcher**: Watches `apps/web/src/components/native-assets/**`
3. **On change**: Cold-start Playwright, screenshot ONLY the changed asset, overwrite its PNG. No persistent browser instance. No regenerating everything.
4. **Build chain**: `cap:build:ios/android` scripts run `asset:generate` → `@capacitor/assets generate` → `cap sync`

Script in root `package.json`:

```json
"asset:generate": "tsx scripts/generate-assets.ts"
```

### 9.5 Store Screenshots (Approach A — Screenshot the Live App)

Zero duplication. Playwright screenshots the actual running app with seeded data during `pnpm dev`. No separate React screenshot components — the screenshots ARE the real app.

**Seed data**: `pnpm db:seed` includes screenshot-specific conversations with carefully chosen messages that showcase features.

**Screenshot set** (6 screens):

| #   | Screen                        | Playwright Actions                                                |
| --- | ----------------------------- | ----------------------------------------------------------------- |
| 1   | Chat streaming                | Navigate to seeded conversation, wait for messages to render      |
| 2   | Model picker open             | Click model selector, wait for dropdown                           |
| 3   | Model switch mid-conversation | Navigate to conversation with multi-model messages                |
| 4   | Encryption indicator          | Show chat view with encryption badge visible                      |
| 5   | Billing transparency          | Navigate to `/billing`, wait for fee breakdown to render          |
| 6   | Document panel                | Navigate to conversation with code block, wait for document panel |

Playwright renders at device resolutions:

- Apple: 1290x2796 (6.7")
- Google: 1080x1920

Screenshots saved to `resources/generated/screenshots/`. Displayed in the `/dev/assets` preview page under a "Store Screenshots" section.

### 9.6 Preview Page — `/dev/assets`

Dev-only route showing a grid of ALL generated PNGs (icons, splash screens, store screenshots) with labels and actual/scaled dimensions.

**Polling**: The preview page polls a lightweight dev middleware endpoint (returns `{ [filename]: mtime }` for files in `public/dev-assets/`) every 2 seconds. When a PNG updates, the `<img>` src is updated with a cache-busting `?t=timestamp` query param. No manual refresh needed.

**Sidebar button**: Added to the left sidebar next to the existing Personas dev button. Only renders when `env.isLocalDev` is true.

---

## 10. Email Preview Migration

### 10.1 Current State

`scripts/email-preview.ts` — standalone HTTP server on port 3333, shows all 5 email templates in iframes with live reload. Run via `pnpm email:preview`.

### 10.2 New State

**Deleted**: `scripts/email-preview.ts` and `pnpm email:preview` script.

**New API endpoint**: `GET /api/dev/emails` — dev-only route that renders all templates with sample data, returns `{ templates: [{ name, label, html }] }`. Uses the same `TEMPLATES` map from the deleted script. Middleware: `devOnly()`.

**New web route**: `/dev/emails` — fetches from `GET /api/dev/emails`, displays each template's HTML in an iframe. Same visual pattern as the asset preview grid (dark background, labeled sections).

**Hot-reload**: Wrangler hot-reloads when template files change → next fetch from `/api/dev/emails` returns updated HTML. Preview page can poll or use a refresh button.

**Sidebar button**: Added next to Assets and Personas dev buttons.

**Modified**: `apps/api/src/routes/dev.ts` — add `GET /emails` endpoint.

---

## 11. Privacy Manifest (iOS)

**New file**: `apps/web/ios/App/App/PrivacyInfo.xcprivacy`

Apple requires this XML plist declaring which system APIs your app uses and why. Without it, App Store submission is instantly rejected (automated check).

Required declarations for Capacitor:

| API Category                                 | Reason Code | Why                                     |
| -------------------------------------------- | ----------- | --------------------------------------- |
| `NSPrivacyAccessedAPICategoryFileTimestamp`  | `C617.1`    | Capacitor core accesses file timestamps |
| `NSPrivacyAccessedAPICategoryDiskSpace`      | `E174.1`    | Capacitor checks available disk space   |
| `NSPrivacyAccessedAPICategoryUserDefaults`   | `CA92.1`    | Capacitor uses UserDefaults             |
| `NSPrivacyAccessedAPICategorySystemBootTime` | `35F9.1`    | Capacitor calculates time intervals     |

Plus: `NSPrivacyTracking: false`, empty `NSPrivacyTrackingDomains`, empty `NSPrivacyCollectedDataTypes`.

---

## 12. Deep Links / Universal Links

When someone taps a `hushbox.ai` link on their phone, the OS opens it in the app instead of the browser.

### 12.1 iOS — Associated Domains

**New**: `apps/marketing/public/.well-known/apple-app-site-association`

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["TEAMID.ai.hushbox.app"],
        "paths": ["/chat/*", "/share/*", "/billing", "/settings", "/login", "/signup"]
      }
    ]
  }
}
```

**Modified**: `apps/web/ios/App/App/App.entitlements` — add `applinks:hushbox.ai`.

### 12.2 Android — App Links

**New**: `apps/marketing/public/.well-known/assetlinks.json`

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "ai.hushbox.app",
      "sha256_cert_fingerprints": ["SHA256_FINGERPRINT"]
    }
  }
]
```

**Modified**: `apps/web/android/app/src/main/AndroidManifest.xml` — add intent filter with `autoVerify="true"` for `https://hushbox.ai`.

### 12.3 Handling in App

`useDeepLinks()` hook — listens for `appUrlOpen` event from `@capacitor/app`, parses URL path, navigates via TanStack Router. Uses the same route constants from `packages/shared/src/routes.ts`.

---

## 13. Live Update Architecture (Capgo)

### 13.1 Version String — Env Variable

Add to `packages/shared/src/env.config.ts`:

```typescript
APP_VERSION: {
  to: [Destination.Backend],
  [Mode.Development]: 'dev-local',
  [Mode.CiVitest]: 'test',
  [Mode.CiE2E]: 'test',
  [Mode.Production]: 'SET_BY_CI',
},
VITE_APP_VERSION: {
  to: [Destination.Frontend],
  [Mode.Development]: 'dev-local',
  // ... same pattern
},
```

CI sets the production value (git short SHA or semver tag) via the GitHub environment. The env management system (`pnpm generate:env`) handles propagation. In `wrangler.toml`, `APP_VERSION` is listed under `[vars]`.

### 13.2 Version Middleware — No DB, No Redis

**New**: `apps/api/src/middleware/version-check.ts`

Reads `c.env.APP_VERSION` directly — the Worker's compiled-in version IS the current version. Zero storage, zero network calls.

```typescript
const serverVersion = c.env.APP_VERSION;
const clientVersion = c.req.header('X-App-Version');
if (clientVersion && clientVersion !== serverVersion && serverVersion !== 'dev-local') {
  const platform = c.get('platform');
  if (platform === 'web') {
    return c.json({ code: 'UPGRADE_REQUIRED', currentVersion: serverVersion }, 426);
  }
  // Mobile: include download URL
  return c.json(
    {
      code: 'UPGRADE_REQUIRED',
      currentVersion: serverVersion,
      updateUrl: `/api/updates/download/${serverVersion}`,
    },
    426
  );
}
```

Skip if: dev/test mode, no header, health/webhook/token-login routes.

### 13.3 R2 Integration

**Modified**: `apps/api/wrangler.toml` — add R2 binding:

```toml
[[r2_buckets]]
binding = "APP_BUILDS"
bucket_name = "hushbox-app-builds"
```

**Modified**: `apps/api/src/types.ts` — add `APP_BUILDS: R2Bucket` to `Bindings`.

**New route**: `apps/api/src/routes/updates.ts`

- `GET /api/updates/current` — returns `{ version: c.env.APP_VERSION }`
- `GET /api/updates/download/:version` — streams zip from R2 binding

### 13.4 Web 426 Handling — Refresh Modal

**New**: `apps/web/src/components/shared/upgrade-required-modal.tsx` — non-dismissable full-screen modal with [Refresh] button → `window.location.reload()`.

**New**: `apps/web/src/stores/app-version.ts` — Zustand store with `upgradeRequired` flag.

**Modified**: `apps/web/src/lib/api-client.ts` — in `fetchJson()`, intercept 426:

```typescript
if (res.status === 426) {
  handleUpgradeRequired(body);
  throw new ApiError('UPGRADE_REQUIRED', 426, body);
}
```

**Modified**: `apps/web/src/routes/__root.tsx` — render `<UpgradeRequiredModal />` when flag set.

### 13.5 Mobile 426 Handling — Capgo OTA

**New**: `apps/web/src/capacitor/live-update.ts`

On startup:

1. `CapacitorUpdater.current()` → get current bundle version
2. `GET /api/updates/current` → get server version
3. If different: show blocking "Updating..." spinner, `CapacitorUpdater.download({ url, version })`, `CapacitorUpdater.set(bundle)`, reload

On 426 during usage: same flow — block UI, download, apply, reload.

Capgo stores the version string you provide to `download()` on the device. `CapacitorUpdater.current()` returns it back — it's echoing your string, not deriving it from bundle contents.

### 13.6 Local R2 Development — Wrangler Native Emulation

No MinIO. No docker-compose changes. Wrangler's built-in R2 emulation handles the `APP_BUILDS` bucket locally via `--persist-to .wrangler/state` (default behavior in `wrangler dev`). The R2 binding in `wrangler.toml` works identically in local dev and production.

### 13.7 Automated Capgo Test Script

**New script**: `pnpm cap:test-update` — fully automated local live update testing. Zero manual steps.

**New dev-only endpoint**: `POST /api/dev/set-version` — temporarily overrides `APP_VERSION` in memory for the running Wrangler instance. Dev-only (`devOnly()` middleware). Accepts `{ version: string }`.

**New**: `apps/api/src/routes/dev.ts` — add `POST /set-version` endpoint. Stores override in module-level variable, version-check middleware reads override first (dev only), falls back to `c.env.APP_VERSION`.

**New script**: `scripts/cap-test-update.ts`

Flow:

1. Query `GET /api/updates/current` to snapshot the current version
2. Generate new version string: `dev-update-{timestamp}`
3. Run `vite build` with `VITE_APP_VERSION=dev-update-{timestamp}`
4. Zip `apps/web/dist/`
5. Upload zip to local R2 via `wrangler r2 object put hushbox-app-builds/builds/dev-update-{timestamp}.zip --file ...` (uses Wrangler's local persistence)
6. Call `POST /api/dev/set-version` with `{ version: 'dev-update-{timestamp}' }`
7. Log: "Version updated. Next API call from the emulator will trigger Capgo update."

The running Android emulator app now has the old version → next API call gets 426 → Capgo downloads from local R2 → applies → reloads with new bundle.

Script in root `package.json`:

```json
"cap:test-update": "tsx scripts/cap-test-update.ts"
```

---

## 14. Legal Pages

Link out to system browser — no bundling.

**Modified**: Settings page (or wherever legal links live) — "Privacy Policy" and "Terms of Service" links call:

```typescript
import { openExternalUrl } from '@/capacitor';
await openExternalUrl('https://hushbox.ai/privacy');
```

On web, falls back to `window.open()`. On native, opens system browser via `@capacitor/browser`.

---

## 15. Obtainium (Replaces F-Droid)

No F-Droid. No Android build flavors. No Google dependency stripping. Single Android build for Play Store.

For Obtainium: GitHub Releases with signed APK. Users point Obtainium at the repo for auto-updates.

### 15.1 Obtainium Build

CI builds a signed APK with `VITE_PLATFORM=android-direct` (payments enabled). Attached to a GitHub Release tagged with the version.

### 15.2 Play Store Build

CI builds a signed AAB with `VITE_PLATFORM=android` (payments disabled). Uploaded via Fastlane.

---

## 16. CI/CD — Fastlane + GitHub Actions

### 16.1 Fastlane Setup

**New**: `apps/web/ios/fastlane/Fastfile` — iOS lane: build, archive, upload to App Store (production, no TestFlight)
**New**: `apps/web/android/fastlane/Fastfile` — Android lane: build AAB, upload to Play Store production track

### 16.2 CI Workflows

**New**: `.github/workflows/release.yml` — triggered by manual `workflow_dispatch` or tag push (`v*`). Only for native shell changes.

Jobs:

1. **Build web**: `vite build` with version + platform vars, `pnpm asset:generate`
2. **iOS**: Install Xcode, CocoaPods, `cap sync ios`, Fastlane build + upload to App Store
3. **Android Play Store**: Set up JDK, `cap sync android`, Fastlane build AAB (`VITE_PLATFORM=android`) + upload
4. **Android Obtainium**: Build signed APK (`VITE_PLATFORM=android-direct`), create GitHub Release with APK attached

Secrets: App Store Connect API key, Play Console service account JSON, iOS distribution cert + provisioning profile, Android release keystore.

**Modified**: `.github/workflows/ci.yml` — deploy job additions:

1. Set version: `echo "version=$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT`
2. Build with version: pass `VITE_APP_VERSION` and `APP_VERSION` env vars
3. Zip dist: `cd apps/web/dist && zip -r ../../../web-dist.zip .`
4. Upload to R2: `wrangler r2 object put hushbox-app-builds/builds/${version}.zip --file web-dist.zip`
5. Deploy API + Web (existing steps) — APP_VERSION set via GitHub environment
6. **Critical ordering**: Deploy first, THEN the new `APP_VERSION` takes effect (it's part of the deployed Worker code)

---

## 17. WebSocket Network Awareness

**Modified**: `apps/web/src/lib/ws-client.ts`

Network-aware reconnection via `useNetworkStatus()`:

- On network loss: stop reconnect attempts (pointless without connectivity)
- On network restore: reconnect immediately (skip exponential backoff)

---

## 18. Complete File Change Summary

### New Files (~45)

**Packages:**

- `packages/shared/src/platform.ts` + test
- `packages/db/src/schema/device-tokens.ts`

**API:**

- `apps/api/src/middleware/platform.ts` + test
- `apps/api/src/middleware/version-check.ts` + test
- `apps/api/src/routes/device-tokens.ts` + test
- `apps/api/src/routes/token-login.ts` + test
- `apps/api/src/routes/updates.ts` + test
- `apps/api/src/services/push/push-service.ts` + test
- `apps/api/src/services/email/templates/welcome.ts` + test

**Web — Capacitor:**

- `apps/web/capacitor.config.ts`
- `apps/web/src/capacitor/platform.ts` + test
- `apps/web/src/capacitor/browser.ts` + test
- `apps/web/src/capacitor/live-update.ts` + test
- `apps/web/src/capacitor/provider.tsx` + test
- `apps/web/src/capacitor/hooks/use-push-notifications.ts` + test
- `apps/web/src/capacitor/hooks/use-network-status.ts` + test
- `apps/web/src/capacitor/hooks/use-deep-links.ts` + test
- `apps/web/src/capacitor/hooks/use-app-lifecycle.ts` + test
- `apps/web/src/capacitor/hooks/use-back-button.ts` + test
- `apps/web/src/capacitor/hooks/use-splash-screen.ts` + test
- `apps/web/src/capacitor/hooks/use-status-bar.ts` + test
- `apps/web/src/capacitor/index.ts`

**Web — UI:**

- `apps/web/src/components/billing/manage-online-button.tsx` + test
- `apps/web/src/components/shared/upgrade-required-modal.tsx` + test
- `apps/web/src/components/shared/offline-overlay.tsx` + test
- `apps/web/src/stores/app-version.ts` + test
- `apps/web/src/stores/network.ts` + test

**Web — Native Assets:**

- `apps/web/src/components/native-assets/app-icon.tsx`
- `apps/web/src/components/native-assets/icon-foreground.tsx`
- `apps/web/src/components/native-assets/icon-background.tsx`
- `apps/web/src/components/native-assets/splash-light.tsx`
- `apps/web/src/components/native-assets/splash-dark.tsx`

**Web — Dev Routes:**

- `apps/web/src/routes/_dev/assets.tsx`
- `apps/web/src/routes/_dev/assets.render.$name.tsx`
- `apps/web/src/routes/_dev/emails.tsx`

**Scripts:**

- `scripts/generate-assets.ts` + test
- `scripts/cap-test-update.ts` + test

**Native / Config:**

- `apps/web/ios/` (generated by `cap add ios`)
- `apps/web/android/` (generated by `cap add android`)
- `apps/web/ios/App/App/PrivacyInfo.xcprivacy`
- `apps/web/ios/fastlane/Fastfile`
- `apps/web/android/fastlane/Fastfile`
- `apps/marketing/public/.well-known/apple-app-site-association`
- `apps/marketing/public/.well-known/assetlinks.json`
- `.github/workflows/release.yml`

### Modified Files (~20)

- `apps/web/package.json` — Capacitor deps + scripts
- `apps/api/src/app.ts` — platform middleware, version-check, new routes
- `apps/api/src/types.ts` — `platform` in Variables, `APP_BUILDS` in Bindings
- `apps/api/src/middleware/cors.ts` — add Capacitor origins
- `apps/api/src/middleware/csrf.ts` — add Capacitor origins
- `apps/api/src/lib/session.ts` — `sameSite: 'none'` + `secure: true`
- `apps/api/src/middleware/index.ts` — export new middleware
- `apps/api/src/routes/index.ts` — export new routes
- `apps/api/src/routes/billing.ts` — add `POST /login-link`
- `apps/api/src/routes/dev.ts` — add `GET /emails` endpoint, `POST /set-version` endpoint
- `apps/api/src/lib/redis-registry.ts` — add `billingLoginToken` key
- `apps/api/wrangler.toml` — R2 binding, `APP_VERSION` var
- `apps/web/src/lib/api-client.ts` — version/platform headers, 426 interception
- `apps/web/src/routes/__root.tsx` — CapacitorProvider, UpgradeRequiredModal, OfflineOverlay
- `apps/web/src/routes/_app/billing.tsx` — platform-conditional rendering, token handling
- `apps/web/src/providers/theme-provider.tsx` — call useStatusBar()
- `apps/web/src/lib/ws-client.ts` — network-aware reconnection
- `packages/shared/src/env.config.ts` — VITE_PLATFORM, VITE_APP_VERSION, APP_VERSION
- `packages/shared/src/schemas/api/error.ts` — new error codes
- `packages/shared/src/error-messages.ts` — friendly messages
- `packages/db/src/schema/index.ts` — export device-tokens
- `packages/db/src/schema/conversation-members.ts` — add `muted` column
- `.github/workflows/ci.yml` — version injection, R2 upload
- `.gitignore` — Capacitor build artifacts, generated assets
- `scripts/dev.ts` — asset watcher process
- `scripts/email-preview.ts` — **deleted**

### Deleted Files

- `scripts/email-preview.ts`
- `scripts/email-preview.test.ts`

---

## 19. Implementation Phases

### Phase A: Foundation

1. Platform detection utilities (shared + capacitor)
2. New error codes and messages
3. DB schemas (device_tokens, muted column) + migrations
4. Redis registry additions (billingLoginToken)
5. Env config changes (VITE_PLATFORM, VITE_APP_VERSION, APP_VERSION)

### Phase B: Capacitor Setup

1. Install Capacitor core + CLI + plugins
2. Create capacitor.config.ts
3. Add iOS + Android platforms
4. Backend: CORS + CSRF + sameSite changes
5. Platform middleware
6. Update .gitignore
7. Verify cookie auth in native WebView

### Phase C: Capacitor Hooks & Provider

1. All hooks in `capacitor/hooks/` (7 hooks, each with test)
2. CapacitorProvider (thin shell)
3. Status bar integration in ThemeProvider
4. Splash screen timing
5. Network status store + offline overlay
6. Android back button
7. Deep link handling
8. Browser utility

### Phase D: Push Notifications

1. Device token API endpoints
2. FCM push sending service
3. Frontend hook (register, handle taps)
4. Mute UI (three-dot menu toggle)
5. Push triggers (chat route + group messages)

### Phase E: Payment Remodeling

1. Login link endpoint (`POST /api/billing/login-link`)
2. Token redemption route with billing-scoped session
3. ManageOnlineButton component
4. Billing page conditional rendering + token handling
5. Welcome email template + registration trigger

### Phase F: Live Update Architecture

1. R2 binding in wrangler.toml (Wrangler emulates locally) + updates route
2. Version middleware (reads `c.env.APP_VERSION`)
3. Dev-only `POST /api/dev/set-version` endpoint
4. Web 426 handling (UpgradeRequiredModal)
5. Mobile 426 handling (Capgo live-update.ts)
6. Automated Capgo test script (`scripts/cap-test-update.ts`)
7. CI pipeline changes (version injection, R2 upload)

### Phase G: Native Asset Pipeline

1. Asset React components (icon, splash, foreground/background)
2. Render routes + preview route
3. generate-assets.ts script (Playwright)
4. Asset watcher in scripts/dev.ts
5. Store screenshot seed data + Playwright capture
6. Preview page polling

### Phase H: Dev Tool Migration

1. Email preview API endpoint (`GET /api/dev/emails`)
2. `/dev/emails` web route
3. Sidebar buttons (Assets, Emails, Personas)
4. Delete `scripts/email-preview.ts`

### Phase I: Native Platform Config

1. Privacy Manifest (iOS)
2. Deep links — AASA file, entitlements (iOS)
3. App links — assetlinks.json, intent filters (Android)
4. Legal page links (Browser.open)

### Phase J: CI/CD + Store Deployment

1. Fastlane setup (iOS + Android)
2. release.yml workflow (App Store, Play Store, Obtainium)
3. ci.yml additions (version injection, R2 upload)

---

## 20. Verification

### Unit/Integration Tests

- `pnpm test` — all packages pass (95% coverage maintained)
- Each new module has tests (TDD per AGENT-RULES.md)
- Platform detection: mock `import.meta.env.VITE_PLATFORM` for each value
- Push service: mock FCM HTTP calls
- Version middleware: test match/mismatch/skip with `c.env.APP_VERSION`
- Token-login: test generation, redemption, expiry, one-time-use, billing-scope restriction
- Mute: test push skips muted members

### E2E Tests

- `pnpm e2e` — existing flows pass on web
- New: billing page renders "Manage Balance Online" when `VITE_PLATFORM=ios`
- New: 426 response shows upgrade modal
- New: offline overlay appears on network disconnect

### Manual Verification (Android Only — No iOS Local Testing)

Local testing is Android-only. iOS builds happen in CI (GitHub Actions macOS runners). The Android emulator runs via IntelliJ IDEA Ultimate's Android plugin (same engine as Android Studio — no separate install needed).

- Build Android: `cd apps/web && pnpm cap:build:android && pnpm cap:open:android` → run in IntelliJ Android emulator
- Verify: login (cookie auth), chat (SSE streaming), WebSocket, theme → status bar, splash hide, push permission prompt, deep links, back button
- Verify billing: "Manage Balance Online" → system browser → token login → add credits on web
- Verify live update: `pnpm cap:test-update` → emulator app gets 426 on next API call → Capgo downloads → applies → reloads
- Verify assets: `pnpm dev` → navigate to `/dev/assets` → all PNGs render correctly
- Verify emails: `pnpm dev` → navigate to `/dev/emails` → all templates render correctly
