# Slice template

Canonical skeleton for a vertical slice. Copy this directory to
`src/slices/<your-slice>/`, rename the example files, and delete what you do
not need. The template itself is scaffolding, not code: lint, knip, coverage,
jscpd, and the arch harness all ignore it. It IS included in the package
tsconfig, so `routes.ts` compiles against the real manifest contract
(`defineSliceManifest`, `routeClass`, `AppEnv` from
`src/middleware/pipeline-manifest.ts`) — contract drift in the template fails
`typecheck` even without tests.

## Layout and layer rules

```
<slice>/
├── index.ts      # the BARREL — the slice's broad public surface
├── public/       # narrow doors — one capability per file, for other slices
├── routes.ts     # HTTP wiring as ONE slice manifest, no business logic
├── domain/       # business logic
│   ├── index.ts  # the domain barrel routes import from
│   └── *.ts
├── ports/        # interfaces for infra this slice's domain depends on
│   └── *.ts
└── adapters/     # implementations of ports; infra clients live here
    └── *.ts
```

Enforced by `eslint-plugin-boundaries` (see
`packages/config/eslint-extensions/boundaries.config.mjs`) and the
ts-morph harness (`packages/config/arch/`):

- **Cross-slice:** another slice may import this slice ONLY via `index.ts` or
  a `public/` module.
  Reaching into `domain/`, `ports/`, `adapters/`, or `routes.ts` from outside
  fails lint. Cross-slice writes go through published APIs inside the
  orchestrating slice's transaction (single-writer-per-table).
- **public/** is the narrow door; the barrel is the broad one. A `public/`
  module holds ONE capability and is named for it, and lint holds it to this
  slice and the lib dirs — never another slice. That is what makes consuming
  one pull in a capability rather than a whole slice; like the barrel and
  unlike `domain/`, it may reach this slice's `adapters/`.
  - Which door to use is convention in general, and enforced wherever the
    barrel route would close a cycle: there `import/no-cycle` rejects the
    barrel import and the door is the only legal route. Default to the
    barrel; add a `public/` module when the consumer is another slice's
    `domain/`. Non-slice consumers (app assembly, middleware, the job
    registry, dev/seed) use the barrel.
  - The door is unconditional rather than "when a cycle would form", because
    "would this make a cycle?" is not a fact about your file. A barrel import
    is safe only while nothing imports you back — a property of your slice's
    position in the graph that another slice can falsify later without
    touching your code. The door needs no such property: importing only its
    own slice, it cannot create a return edge.
- **routes.ts** imports only this slice's `domain/index.ts`, the middleware
  (`src/middleware/pipeline*`), and externals such as `hono`/`zod`/
  `@hushbox/shared`. It exposes the slice's HTTP surface as one
  `defineSliceManifest` entry whose every route declares a class via
  `routeClass(…)` — the pipeline default-denies undeclared routes. Routes
  hold no business logic and never import repositories or domain internals.
- **domain/** imports only this slice's `ports/` and other domain files, other
  slices' barrels and `public/` modules, and the lib dirs
  (`src/lib/{result,errors,resilience,idempotency,jobs,telemetry}`). Never
  this slice's `adapters/`, never infra libraries (`@neondatabase/*`,
  `@upstash/*`, `drizzle-orm`, …).
- **adapters/** is where this slice's infra clients live — the one slice layer lint
  leaves open to an infra module. Which layers the ban covers is stated in
  `packages/config/eslint-extensions/boundaries.config.mjs`. True external
  seams (gateway, payments, email, push) live here — and they are the only
  modules tests may `vi.mock`. Internal slices are never mocked; tests call
  the real barrel.
- **Wiring** happens at composition time: the `app.ts` assembly calls the
  slice's manifest factory with its adapters and mounts the result with one
  chained `.route(manifest.basePath, manifest.routes)` line, so routes never
  construct adapters themselves. The health slice in `app.ts` is the living
  example.
- New code never imports legacy files — an import that resolves outside the
  slice/lib/middleware trees fails lint as an unknown local.

## The mutation exemplar

`PUT /template/note` is here because layering is not the part of a slice that is
easy to get wrong. It carries, in one route, the parts a write is actually held
to:

- **Validation** — `zValidator('json', schema, rejectInvalid)`. The hook comes
  from the middleware door, never re-declared per slice: it is one shared
  function, and a copy drifts from the uniform `{code}` 400 body.
- **Idempotency** — a mutation passes through `runMutation` over one of the five
  `idempotent.*` wrappers, and `runMutation` accepts only `Idempotent<T>`, so an
  unclassified write cannot compile its way into a route. This one is a single
  upsert converging on one row per user, so it declares
  `idempotencyExempt('naturally-idempotent')` and wraps in `idempotent.byUpsert`;
  the arch harness reads both structurally and requires them to agree. A write
  that would file a SECOND row on a repeat takes no exemption — it requires the
  `Idempotency-Key` header and wraps in `idempotent.byKey`.
- **Errors** — the domain function returns a `Result`; the route's failure arm is
  `respondDomainError`, which resolves the wire code and its status. Domain code
  does not throw for an expected failure, and routes do not build error bodies.
- **The caller** — `callerUserId` reads the pipeline principal. A `session`-class
  route never takes an identity from the request body.

Two things the copy cannot supply: `NoteStore` has no adapter, because its
implementation is the drizzle repository your slice writes; and a mounted route
needs a rate-limit posture entry, which the template, mounted nowhere, has none
of.

## Tests

Colocate `*.test.ts` next to the code. Integration-first: tests run against
real local infra and the real barrels of other slices. The 95% coverage gate
applies to `src/slices/**`.
