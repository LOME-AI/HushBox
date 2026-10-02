# Tech Stack

## Overview

This document defines the complete technology stack for the AI chat aggregator application. All choices optimize for: serverless architecture, local development parity, end-to-end type safety, minimal vendor lock-in, and cost efficiency.

---

## Core Values

**Serverless Architecture**
Pay for what you use. Zero idle costs.

**Local Development Parity**
Every production service runs locally. Developers never need production access. What works on your machine works in production.

**Proven Before Production**
Every behaviour is proven locally against the real stack, or in CI with an evidence row where a vendor cannot be emulated. Production is a proving ground only for a best-effort mechanism that fails open, and each such exception is recorded in `docs/DECISIONS.md` with its reason and its re-entry condition.

**End-to-End Type Safety**
TypeScript everywhere. Shared schemas between frontend and backend. Change a type, get errors everywhere it breaks—before users do.

**Universal Idempotency**
Every operation is safe to retry. Network glitch? Just retry. No duplicate charges, no corrupted state.

**One Mechanism Per Task, Made Recoverable**
No backup mechanisms. Each task has a single mechanism that recovers itself — leases, TTLs, lazy checks. Auditors detect; humans repair. Every system lands on the highest rung of the maintenance ladder it can reach (`CODE-RULES.md` §Unattended by Construction); one that reaches no rung is recorded in `docs/DECISIONS.md` with its reason and its re-entry condition.

**Crash Recovery by Construction**
Nothing commits mid-run, so a crash at any moment leaves nothing to clean up.

**Single Writer Per Table**
Every table has exactly one owning slice; everyone else goes through its published API.

**Configurability Over Rebuild**
Models, capabilities, and workflows are data. New behavior ships as registry entries and definitions, not deploys.

**Frequent Forever Backups**
Hourly incremental backups of the database and the object buckets to a separate vendor and geography (rustic to Backblaze B2). Encrypted, deduplicated, restore-verified.

**Cost Efficiency**
Optimize for low costs.

**Developer Experience First**
One command starts everything. Clear errors. Fast iteration. If it's painful to develop, it's painful to maintain.

**Minimal Vendor Lock-in**
Standard tools, standard protocols.

**Accessibility Compliance**
Every feature works for everyone. WCAG compliance.

**No Security Through Obscurity**
Our security doesn't depend on hiding how things work. The source code is visible. Our architecture is documented. Security comes from good design, not secrets.

---

## Language

| Technology     | Purpose                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| **TypeScript** | All code (frontend, backend, shared packages). Enables type safety across the entire stack with shared schemas. |

---

## Frontend

| Technology                       | Purpose                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **React 19**                     | UI framework. Largest ecosystem, best Capacitor support, excellent for text-heavy interfaces.                                                                                  |
| **Vite**                         | Build tool and dev server. Fast HMR, simple config, no SSR complexity for SPA. Vite 8 bundles with Rolldown natively.                                                          |
| **TanStack Router**              | Routing. Fully type-safe routes, params, and search params. Compile-time errors for invalid routes.                                                                            |
| **TanStack Query**               | Server state management. Caching, background refetching, request deduplication for all API calls.                                                                              |
| **Zustand**                      | Client state management. Lightweight, minimal boilerplate for UI state not tied to server.                                                                                     |
| **shadcn/ui**                    | Source of accessible primitives (Radix-based) in `packages/ui`. Copy-paste ownership; extended in-house with composites and domain features.                                   |
| **Tailwind CSS**                 | Styling. Utility-first, consistent design tokens, pairs with shadcn/ui.                                                                                                        |
| **input-otp**                    | OTP input component. Accessible, mobile-friendly 6-digit code entry for 2FA verification.                                                                                      |
| **react-qrcode-logo**            | QR code generation. Renders TOTP provisioning URIs for authenticator app setup.                                                                                                |
| **Streamdown**                   | Markdown rendering with plugin system. Plugins: `@streamdown/code` (Shiki), `@streamdown/mermaid`, `@streamdown/math` (KaTeX).                                                 |
| **Shiki**                        | Syntax highlighting for code blocks (via `@streamdown/code`).                                                                                                                  |
| **Framer Motion**                | Animation library for transitions and micro-interactions.                                                                                                                      |
| **Lucide React**                 | Icon library. SVG icons used throughout UI.                                                                                                                                    |
| **Recharts**                     | Charts: the admin growth dashboard's series and the web app's usage charts.                                                                                                    |
| **d3-geo** + **topojson-client** | The admin growth dashboard's choropleth (world by country, USA by state), rendered as SVG paths; the map geometry is vendored under `apps/admin/public/geo`, not a dependency. |
| **React Virtuoso**               | Virtual scrolling for long message lists.                                                                                                                                      |
| **kokoro-js**                    | On-device text-to-speech (Kokoro-82M ONNX). Powers chat read-aloud and blog read-aloud; runs fully in-browser, no audio/text sent to servers.                                  |
| **onnxruntime-web**              | WASM runtime under kokoro-js and `@huggingface/transformers`. The `.wasm` and the model weights are self-hosted; the SPA CSP names no model host.                              |

---

## Marketing Site

| Technology | Purpose                                                                             |
| ---------- | ----------------------------------------------------------------------------------- |
| **Astro**  | Static site generator. SSG for SEO, partial hydration, deployed alongside main app. |

---

## Mobile

| Technology                   | Purpose                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Capacitor**                | Native wrapper. Same React codebase runs on iOS/Android with native API access.                                                                                                           |
| **@capacitor-community/fcm** | APNs→FCM token bridge on iOS. Coexists with `@capacitor/push-notifications` (which stays the registration/presentation surface); without it iOS yields a raw APNs token that FCM rejects. |

---

## Backend

| Technology                   | Purpose                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hono**                     | API framework. Ultrafast, runs on Workers/Node/Bun, native streaming support.                                                                     |
| **Zod**                      | Schema validation. Runtime validation + TypeScript inference. Shared schemas between frontend/backend.                                            |
| **@hono/zod-validator**      | Input validation middleware. Zod schemas validate request body/params/query in Hono route chains.                                                 |
| **hono/client**              | Typed RPC client. `hc<AppType>()` infers types from Hono route chains. Ships with `hono`, zero additional dependencies.                           |
| **neverthrow**               | Typed `Result` error channel at service seams. Must-use enforced by a vendored lint rule.                                                         |
| **ts-pattern**               | Exhaustive matching (DomainError→code, node dispatch); compiler catches unhandled variants.                                                       |
| **cockatiel**                | Retry/timeout policies on external calls, built only via the policy factory. No in-isolate breakers.                                              |
| **eslint-plugin-boundaries** | Enforces the product Worker's slice perimeter and intra-slice layers from the import graph (`apps/api/src`) — the one import-graph-governed tree. |
| **ts-morph**                 | Structural architecture tests lint can't express (idempotency wrapping, schema-object scoping).                                                   |
| **jose**                     | Cloudflare Access JWT verification on the product Worker's admin routes; ES256 VAPID signing for Web Push.                                        |
| **isbot**                    | Crawler detection by user agent on the marketing beacon route: a known bot is answered and never counted.                                         |
| **Web Push** _(in-house)_    | RFC 8291/8188/8292 sender on WebCrypto (aes128gcm + VAPID); no third-party library (`docs/NOTIFICATIONS.md`).                                     |

---

## Database

| Technology  | Purpose                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| **Neon**    | Cloud PostgreSQL 18. Serverless, scales to zero, branching for previews. Native uuidv7(). |
| **Drizzle** | ORM. Type-safe, lightweight, identical queries on Neon and local Postgres.                |

---

## Cache

| Technology                | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Upstash Redis**         | Serverless Redis. OPAQUE challenge state, rate limiting, 2FA attempt tracking. |
| **Serverless Redis HTTP** | Local development proxy. Emulates Upstash REST API against local Redis.        |

---

## Hosting

| Technology                     | Purpose                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare Workers**         | API hosting: one product Worker (the admin plane is a slice on it); an assets-only Worker serves the admin SPA on `admin.hushbox.ai` together with a framable copy of the marketing site under `/preview`; a second assets-only Worker serves the document sandbox origin (untrusted code execution) on its own subdomain. |
| **Cloudflare Pages**           | Frontend hosting. Deploys Vite app and Astro marketing site.                                                                                                                                                                                                                                                               |
| **Cloudflare Durable Objects** | Two roles: ConversationRoom (realtime hub, stream coordination, in-process flow executor) and JobDispatcher (alarm-clocked job execution).                                                                                                                                                                                 |
| **Cloudflare Workers Cache**   | Edge caching for the product Worker's declared-storable public reads; the response header, written by the default-deny cache-policy stage, is the whole per-route control. The cache partitions by Worker version, so a deploy starts cold and nothing purges (`docs/CACHING.md`).                                         |

---

## Storage

| Technology        | Purpose                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare R2** | Primary object storage. S3-compatible. User files, artifacts.                                                                                                                               |
| **Backblaze B2**  | Backup storage. Different vendor for disaster recovery. Holds the one encrypted backup repository.                                                                                          |
| **rustic**        | Backup writer. Incremental, encrypted, deduplicated snapshots of Postgres and R2 into one repository, written in the restic format any restic-family tool reads. Design: `docs/BACKUPS.md`. |

---

## Code Execution

| Technology                                           | Purpose                                                                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare Containers / Sandbox SDK** _(deferred)_ | Server-side heavy compute (transcode, code execution) when a feature forces it. Same vendor; behind the `TransformCompute` port.                                                   |
| **Document sandbox** (in-house)                      | Client-side execution of AI-generated documents (`html`/`js`/`react`/`python`) in a sandboxed cross-origin iframe on a credential-free assets Worker. Design: `docs/DOCUMENTS.md`. |
| **Sucrase**                                          | In-browser JSX/TSX transpile inside the sandbox.                                                                                                                                   |
| **Pyodide**                                          | CPython on WebAssembly, self-hosted and version-pinned, run inside the sandbox iframe.                                                                                             |

---

## Authentication

| Technology                | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| **@cloudflare/opaque-ts** | OPAQUE PAKE protocol. Zero-knowledge password auth.                 |
| **iron-session**          | Encrypted session cookies. Stateless, no server-side session store. |
| **otplib**                | TOTP generation and verification for two-factor authentication.     |

---

## Cryptography

| Technology         | Purpose                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **@noble/ciphers** | XChaCha20-Poly1305 AEAD encryption for ECIES message blobs. Audited, zero deps.                                                                                 |
| **@noble/curves**  | X25519 ECDH for key exchange between client and recovery flows.                                                                                                 |
| **@noble/hashes**  | SHA-256, HKDF-SHA-256 for key derivation, epoch confirmation hashes, and content-addressable storage.                                                           |
| **@scure/bip39**   | BIP39 mnemonic generation for 12-word recovery phrases.                                                                                                         |
| **scrypt**         | The password KSF: N=32768, r=8, p=1, applied inside `@cloudflare/opaque-ts` by its default `ScryptMemHardFn`. Not a direct dependency; no code here selects it. |
| **hash-wasm**      | Argon2id (64 MB, 3 iterations, p=4) in WebAssembly. Derives the recovery key from the phrase seed; it is on no password path.                                   |
| **fflate**         | Raw deflate before encryption; the deflated bytes are kept only when strictly smaller than the input.                                                           |

> Argon2id's three call sites are account creation, recovery from a mnemonic, and recovery-phrase
> regeneration — never login or password change, which stretch through scrypt inside the OPAQUE
> library. The `@noble/*` "audited" claim above is the Cure53 audit, whose scope **excludes**
> `argon2` (with `blake3`, `sha3-addons`, and `sha1`); that gap is one reason Argon2id runs
> through `hash-wasm`, a WASM port of the reference implementation, rather than `@noble/hashes`.

---

## Email

| Technology | Purpose                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resend** | Transactional email + newsletter issues (batch API, per-batch idempotency keys). Raw HTTP, no SDK. Bounce/complaint webhooks drive suppression. |

---

## Payments

| Technology | Purpose                                     |
| ---------- | ------------------------------------------- |
| **Helcim** | Payment processing. Handles credit loading. |

---

## Analytics & Observability

| Technology                      | Purpose                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare Workers Logs**     | Off by decision — nothing is retained; Sentry is the sole retained channel.                                                                                                                                                |
| **Sentry**                      | What an operator must act on, backend only. Scrubbed at the Telemetry port; `errorCode` fingerprints.                                                                                                                      |
| **Cloudflare OTel tracing**     | Vendor-neutral tracing; Sentry tracing is the fallback.                                                                                                                                                                    |
| **Growth counter** _(in-house)_ | Marketing-site visit and funnel aggregates: a cookieless, storage-free beacon, a keyed daily hash held only in Redis, set-cardinality counts rolled into Postgres. Never on the app origin (`docs/GROWTH-MEASUREMENT.md`). |
| **PostHog** _(deferred)_        | Product analytics, if ever: self-hosted, no autocapture, never session replay.                                                                                                                                             |

> App-side aggregate/business metrics are not instrumented; the marketing site's aggregates are the growth counter above. Reintroduce Workers Analytics Engine (SQL API + a named watcher per metric) or the deferred PostHog when app-side aggregate measurement is needed.

---

## AI / LLM

| Technology        | Purpose                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vercel AI SDK** | Provider-agnostic streaming inference for text, image, and video. The portability seam behind the `ModelProvider` port (OpenRouter via `@openrouter/ai-sdk-provider`).                              |
| **OpenRouter**    | The single gateway: 100+ models, queryable metadata + queryable ZDR (`/endpoints/zdr`, per-request `provider.zdr`), authoritative inline `usage.cost` as billing truth. Reached through the AI SDK. |
| **Brave Search**  | Web search: a tool the model calls, run server-side from the conversation Durable Object behind the `SearchProvider` port, under the account's zero data retention.                                 |

---

## Development

| Technology          | Purpose                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Turborepo**       | Monorepo orchestration. Parallel builds, caching, task dependencies.                                                                                                                                                                             |
| **pnpm**            | Package manager.                                                                                                                                                                                                                                 |
| **Vitest**          | Unit/integration testing.                                                                                                                                                                                                                        |
| **Playwright**      | E2E testing. Cross-browser.                                                                                                                                                                                                                      |
| **fishery**         | Test factories with traits, sequences, and async DB creation.                                                                                                                                                                                    |
| **@faker-js/faker** | Realistic fake data generation.                                                                                                                                                                                                                  |
| **SILO**            | Local S3-compatible server. Emulates R2 for local dev and CI tests via `pnpm db:up`. A MinIO fork that keeps MinIO's configuration, `mc` client and on-disk layout, so the compose service, its variables and its volume carry the `minio` name. |
| **Payment Mocks**   | Local mock for Helcim. No real API calls in local development.                                                                                                                                                                                   |
| **Helcim Sandbox**  | Helcim's test environment. Used in CI for real payment flow testing.                                                                                                                                                                             |
| **execa**           | Subprocess execution. Clean API for running shell commands from TypeScript scripts.                                                                                                                                                              |
| **tsx**             | TypeScript execution. Runs TypeScript directly without compilation step.                                                                                                                                                                         |

---

## CI/CD

| Technology         | Purpose                                                           |
| ------------------ | ----------------------------------------------------------------- |
| **GitHub Actions** | CI/CD pipelines. Tests on PR, deploy on merge, scheduled backups. |

---

## Licensing

| Item        | Choice                                                |
| ----------- | ----------------------------------------------------- |
| **License** | Proprietary (source-available, no rights granted).    |
| **CLA**     | Required for all contributions via CLA Assistant bot. |

---

## Monorepo Structure

```
/
├── apps/
│   ├── web/              # React + Vite (main application)
│   ├── marketing/        # Astro (marketing site)
│   ├── api/              # Product Worker — vertical slices (map in ARCHITECTURE.md)
│   ├── admin/            # Admin SPA (static assets on admin.hushbox.ai, behind Access)
│   ├── sandbox/          # Document sandbox origin (static assets; runs untrusted document code)
│   ├── docket/           # Audit console + CLI over docs/audits/ (local dev only)
│   └── crawler-view/     # Crawler's-eye page inspector (local dev only)
│
├── packages/
│   ├── ui/               # Shared component library: primitives, composites, hooks, utilities
│   ├── shared/           # Zod schemas, types, constants, contracts
│   ├── db/               # Drizzle schema, migrations, client
│   ├── crypto/           # Encryption, key derivation, OPAQUE helpers
│   ├── realtime/         # Durable Objects: ConversationRoom + JobDispatcher
│   ├── config/           # Shared ESLint, TypeScript configs, arch-test harness
│   └── docket/           # Audit-finding format: parse, validate, serialize, scoped writes
│
├── e2e/                  # Playwright E2E tests
├── scripts/              # Dev tooling (seed, db-reset, generate-env)
├── docs/                 # Documentation (history/ holds archived plans)
├── ads/                  # Ad production workspace: briefs, media (Git LFS), capture + Remotion tooling
├── ops/                  # Production-affecting scripts, PR-label dispatched, gated by the `production` GitHub Environment
│
├── .github/
│   └── workflows/
│       ├── ci.yml        # Test on PR; deploy + tag on merge
│       └── backup.yml    # Hourly backups
│
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── README.md
```
