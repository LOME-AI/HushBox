# Code Rules

---

## Core Principles

### 95% Test Coverage

- 95% line, branch, and function coverage
- No exceptions
- Tests written before or with implementation
- No skipped or commented tests
- Check with `pnpm test:coverage`
- Coverage checked on every push

### Type Safety

- Explicit return types on all functions
- No `any` types without documented justification
- Rely on Drizzle and Zod inference for generated types
- Never manually duplicate inferred types

### Fail Fast

- Validate preconditions immediately
- Never defer errors with fallback values
- Missing config = immediate crash with clear message
- Invalid input = reject at boundary, not deep in logic

### Never Hide Problems

- No `|| true` to hide command failures
- No `2>/dev/null` to suppress errors
- No `@ts-ignore` without explanation
- No `eslint-disable` without justification
- No `--force` or `--legacy-peer-deps`
- No `console.log` or `debugger` in committed code
- Fix root causes, don't mask symptoms

---

## Error Handling

- Never swallow errors silently
- Use custom error classes with context
- Log with sufficient detail for debugging
- Graceful degradation where appropriate
- Every external call wrapped in try/catch

---

## Patterns

### Single Source of Truth

- Drizzle schema defines database types
- Zod schemas define API contracts
- Types flow from these sources, never duplicated

### Environment Detection

- Always use `envUtils` (from `createEnvUtilities()`) for environment branching
- Never check `NODE_ENV`, `CI`, or `E2E` directly
- Never use `??` fallback defaults for environment variables. `envConfig` defines values for every mode
- If a variable is missing at runtime, fail-fast with a clear error
- Backend middleware: use `c.get('envUtils')` (set by `envMiddleware()`)
- Middleware running before `envMiddleware()`: call `createEnvUtilities(c.env)` directly
- Service factories: accept `EnvContext` and call `createEnvUtilities()` internally

### Idempotency

- Every operation safe to retry
- Use unique constraints and upsert
- Check completion before external calls
- Content-addressable keys for storage
- Never use check-then-act. Two queries (check if done, then do it) are vulnerable to race conditions
- Use atomic conditional updates: `UPDATE ... WHERE condition_not_met` inside a transaction, and check rows affected

### Direct Resource Access

- No gatekeeper services
- Type-safe wrappers for all external resources
- Packages provide safety without network hops

### API Client

- `apps/web/src/lib/api-client.ts` is the single source for all typed API calls
- All server state management uses TanStack Query hooks wrapping the typed client
- Never use raw `fetch()` for API endpoints covered by the typed client
- Hono route definitions are the single source of API types (via `AppType` export)

### Error Responses

- API errors return `{ code: string, details?: object }`, with no message field
- `code` is a machine-readable constant exported from `packages/shared/src/schemas/api/error.ts`
- Frontend maps `code` to user-facing message via `friendlyErrorMessage()` from `@hushbox/shared`
- All user-facing error messages live in `packages/shared/src/error-messages.ts`
- New error codes need: (1) constant in shared error schema, (2) entry in `friendlyErrorMessage` map
- Budget/billing notifications use `generateNotifications()` (separate system, already user-friendly)
- Use `createErrorResponse(code, details?)` for all API error responses; never `c.json({ error: ... })`

### Serverless Mindset

- Handle cold starts gracefully
- No persistent in-memory state
- State lives in database or Redis only

---

## Accessibility-friendly Conventions

These conventions keep the accessibility widget's CSS overrides effective as the codebase grows. Lint rules in `packages/config/eslint.config.js` enforce them automatically.

### Use Tailwind classes or CSS variables, never inline color/font styles

- ❌ `<div style={{ color: '#ff0000', fontSize: 14 }} />`
- ✅ `<div className="text-destructive text-sm" />`

Inline `style` props for `color`, `backgroundColor`, `borderColor`, `fontFamily`, `fontSize`, `fill`, `stroke` are banned by ESLint. The widget's contrast and font-scaling toggles can't override values that were hardcoded inline.

**Exemptions:** native-asset generators (splash-screen, app-icon) that render to PNG. Use `eslint-disable-next-line no-restricted-syntax` with a comment explaining the exemption.

### Use `<Img>` for content images and `<Logo>` for decorative branding — never raw `<img>`

- ❌ `<img src="/photo.jpg" alt="..." />`
- ✅ `<Img src="/photo.jpg" alt="..." />` (content image — auto-inverts in inverted-color mode)
- ✅ `<Logo />` (decorative brand mark — exempt from inversion)

Both are exported from `@hushbox/ui`. The `Img` wrapper requires `alt`, defaults to `loading="lazy"`, and supports a `decorative` prop that adds `data-no-invert`. Raw `<img>` in `.tsx` is banned by ESLint.

### Use `useAnimationFrame` instead of `window.requestAnimationFrame`

- ❌ `const id = window.requestAnimationFrame(tick)`
- ✅ `useAnimationFrame((timestamp) => { /* tick */ })`

The wrapper from `@hushbox/ui` respects `prefers-reduced-motion` and the user's "stop animations" toggle. Raw `requestAnimationFrame` is banned by ESLint.

JS animation libraries (`gsap`, `anime`, `motion-one`) are also banned via `no-restricted-imports`. Use Framer Motion (already in the stack) or CSS animations.

### Prefer semantic HTML over ARIA roles

- ❌ `<div role="main">`, `<div role="navigation">`, `<div onClick={...}>`
- ✅ `<main>`, `<nav>`, `<button onClick={...}>`

Semantic tags imply roles, support keyboard interactions natively, and integrate with the page-structure landmarks navigator without configuration.

Tag chrome wrappers (sidebar, header, footer, panels surrounding main content) with `data-chrome=""` for future opt-out behaviors (e.g. focus-mode toggles).

---

## Code Organization

### Naming

- Filenames: `kebab-case` (e.g. `two-factor-setup.tsx`, `use-delete-account.ts`)
- Component symbols: `PascalCase` (the export name, not the filename)
- Hook/utility symbols: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Types: `PascalCase`
- Tests: `*.test.ts`

### Structure

- Colocate tests with source
- Shared code in `packages/`, never copy-pasted
- One component/function per file
- `index.ts` for exports only

### Imports

1. External dependencies
2. Internal packages (`@/packages/*`)
3. Relative imports
4. Type imports last

---

## Testing

### Requirements

- Unit tests for all business logic
- Integration tests for database and API operations
- E2E tests for critical user flows
- Tests must not depend on execution order
- No hardcoded dates (use time mocking)
- Test behavior, not implementation

### What to Test

- Happy paths
- Error conditions
- Edge cases and boundaries
- Idempotency
- Input validation

---

## Security

- Validate all external input with Zod
- Never trust client-provided IDs
- Never interpolate user input in queries
- Never hardcode or log secrets
- Rate limit auth endpoints

---

## Performance

- Measure before optimizing
- Add indexes for common queries
- Cache expensive computations
- Paginate list endpoints
- Stream large responses
- Use workers for tasks >5 seconds

---

## Documentation

### When to Comment

Comment durable facts that a future reader with no context cannot derive from the code, names, types, or tests, when the information is load-bearing on correctness or future modification and survives the current task.

Examples:

- Non-obvious business or domain logic
- Source-of-truth designations
- Hidden coupling between files or modules
- Race conditions and ordering constraints
- Security or regulatory requirements the code enforces but doesn't explain
- Performance traps
- Library, browser, or external API quirks
- Rejected alternatives with the reason for rejection
- Code that looks removable but isn't
- Exceptions to established rules
- Subtle edge cases

A wrong comment is worse than no comment. If you can't state the durable fact precisely, leave it out.

### When Not to Comment

- Obvious operations
- Self-explanatory names
- Standard patterns
- What code does (code shows this)
- Code you didn't change

### Never Include

- Specific file paths that may move
- Hardcoded version numbers
- Specific timing estimates
- Ephemeral values (container IDs, hashes)
- TODO and FIXME

---

## Enforcement

- Pre-commit: Prettier, basic lint
- Pre-push: ESLint, typecheck, tests
- CI: Full test suite, coverage check
- Review: Human judgment on patterns and quality

No exceptions.