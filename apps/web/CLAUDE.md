# Web app (apps/web)

The React SPA. Visual identity and copy rules: `docs/DESIGN.md` + `docs/PRODUCT.md`
govern any user-facing surface.

## API calls

- `src/lib/api-client.ts` is the sole typed API surface: `hc<AppType>()` plus the
  `fetchJson()` unwrap, injecting the `X-HushBox-Platform` / `X-App-Version` /
  `X-Link-Public-Key` headers. Never raw `fetch()` for endpoints the typed client
  covers.
- Server state goes through TanStack Query hooks wrapping the typed client.
- Every mutation — a `useMutation` or one built on the query client's mutation cache —
  carries an `Idempotency-Key` through the helpers in
  `src/lib/api/idempotent-mutation.ts`, or declares in its `meta` why it sends none
  with `idempotencyExempt('<class>')` from that same module, which holds the closed
  set of classes. The arch rule `web-mutations-declare-idempotency` refuses a mutation
  that does neither. The key is what licenses retrying a transient server failure; a
  keyless mutation keeps the network-only retry.
- **Query-key factories are per-hook-file objects** (the `billingKeys` / `usageKeys`
  pattern in `src/hooks/`) — there is no central key registry and none should be
  invented (`src/lib/query-keys/` holds only blob-cache keys).

## UI conventions

- Model catalog fixtures bind to the shared catalog contract; the arch rule
  `model-fixtures-bind-to-the-contract` pins it.
- Test ids come only from the `TEST_IDS` / `TEST_ID_BUILDERS` registry in
  `@hushbox/shared` — literal `data-testid` strings are lint-banned.
- Use `@hushbox/ui` primitives; the accessibility wrappers are lint-enforced:
  `<Img>` / `<Logo>` (never raw `<img>`), `useAnimationFrame` (never raw
  `requestAnimationFrame`), no inline color/font styles — every color and font from
  Tailwind tokens.
- Assistant text is framed by the one grammar in `@hushbox/shared`; render it only through
  the segment renderers in `apps/web/src/components/chat/segments/`, and never write a frame
  delimiter or display raw message text unparsed.
