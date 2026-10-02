# Admin SPA

The admin panel: a static SPA served on `admin.hushbox.ai` behind Cloudflare Access,
talking to the product Worker's admin slice via `hc<AppType>()`. Visual identity:
`docs/DESIGN.md` §Admin app (density-first deltas on the product identity). Backend
rules: `apps/api/src/slices/admin/CLAUDE.md`. This file is the permanent home for the
conventions below.

## Conventions

- **One generic `<OpForm>`, never bespoke op forms.** Forms render from the shared op
  contracts' Zod schemas. If a form can't be generated, the op's input schema is wrong
  (inputs must stay flat) — fix the contract, don't hand-build the form.
- **Every mutation flows through the OpModal** — the form → preview-diff → execute/undo
  grammar is the app's one interaction signature. No bespoke confirm dialogs, no
  mutation outside it. The modal mints the `Idempotency-Key` at form-submit.
- **Preview before execute, undo after.** The preview step renders the engine's dry-run
  effects via `<DiffList>`; guardrail violations surface there as blocking errors. The
  result state offers Undo (the inverse op through the same modal) exactly when the op's
  contract names an inverse — which the Reversibility Iron Law requires of every
  `durable` op and refuses to every other effect class.
- **Panels fail independently.** The Customer-360 view is one query whose response
  carries each panel's own data or own error, rendered per panel — one broken panel never
  blanks the page.
- **Palette-first navigation.** ⌘K reaches any user (by email/id), any op, any screen;
  every workflow must be completable without a pointer.
- **Ops appear automatically; screens declare their roles.** The ops catalog and nav
  derive from `GET /api/admin/ops`; adding an op requires zero code in this app. A
  screen is different: its navigation entry names the roles that may see it, and the
  nav filters on the signed-in role — a screen with no `roles` is not reachable.
- **Vendor internals deep-link out.** HushBox-owned data renders here; Sentry stack
  traces link to Sentry's dashboard, never re-implemented.
- Follow the web app's mechanics: TanStack Router/Query, centralized query-key
  factories, shared-Zod response re-validation, the `TEST_IDS` registry (no raw
  testids), `@hushbox/ui` primitives, the accessibility conventions.
