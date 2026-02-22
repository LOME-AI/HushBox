# Code Rules

Coding standards for all contributors (human and AI).

---

## Core Principles

### 95% Test Coverage

- No exceptions
- Tests written before or with implementation
- No skipped or commented tests
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
- Never use `??` fallback defaults for environment variables — `envConfig` defines values for every mode
- If a variable is missing at runtime, fail-fast with a clear error
- Backend middleware: use `c.get('envUtils')` (set by `envMiddleware()`)
- Middleware running before `envMiddleware()`: call `createEnvUtilities(c.env)` directly
- Service factories: accept `EnvContext` and call `createEnvUtilities()` internally

### Idempotency

- Every operation safe to retry
- Use unique constraints and upsert
- Check completion before external calls
- Content-addressable keys for storage
- Never use check-then-act - Two queries (check if done, then do it) are vulnerable to race conditions.
- Use atomic conditional updates: `UPDATE ... WHERE condition_not_met` inside a transaction, and check rows affected.

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

- API errors return `{ code: string, details?: object }` — no message field
- `code` is a machine-readable constant exported from `packages/shared/src/schemas/api/error.ts`
- Frontend maps `code` → user-facing message via `friendlyErrorMessage()` from `@hushbox/shared`
- All user-facing error messages live in `packages/shared/src/error-messages.ts`
- New error codes need: (1) constant in shared error schema, (2) entry in `friendlyErrorMessage` map
- Budget/billing notifications use `generateNotifications()` (separate system, already user-friendly)
- Use `createErrorResponse(code, details?)` for all API error responses — never `c.json({ error: ... })`

### Serverless Mindset

- Handle cold starts gracefully
- No persistent in-memory state
- State lives in database or Redis only

---

## Code Organization

### Naming

- Components: `PascalCase.tsx`
- Utilities: `camelCase.ts`
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

- Non-obvious business logic
- Exceptions to established rules
- Complex algorithms
- Subtle edge cases

### When Not to Comment

- Obvious operations
- Self-explanatory names
- Standard patterns
- What code does (code shows this)

### Never Include

- Specific file paths that may move
- Hardcoded version numbers
- Specific timing estimates
- Ephemeral values (container IDs, hashes)

---

## Enforcement

- Pre-commit: Prettier, basic lint
- Pre-push: ESLint, typecheck, tests
- CI: Full test suite, coverage check
- Review: Human judgment on patterns and quality

No exceptions.
