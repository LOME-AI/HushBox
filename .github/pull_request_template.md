## Summary

<!-- 1–2 sentences. What does this PR do, and why? -->

## Changes

<!-- Notable changes as bullet points. Group by area for larger PRs. -->

-

## Test plan

<!-- docs/CODE-RULES.md: TDD enforced, 95% coverage on changed files,
     tests describe behavior not implementation. -->

- [ ] Unit / integration / E2E tests added or updated (failing test first)
- [ ] `pnpm typecheck` and `pnpm test` clean locally
- [ ] Exercised in dev environment (or noted as untested below)

## Linked work

<!-- "Fixes #N", "Part of <epic>".
     Use "N/A" for independent maintenance. -->

---

<!-- Sections below are skip-if-not-applicable. Delete the heading and the
     surrounding comment if your PR doesn't touch the area. -->

### Schema / migrations

- [ ] Migration is idempotent (safe to re-run)
- [ ] DELETE-before-DROP COLUMN ordering verified for destructive changes
- [ ] `pnpm db:generate` produces no diff
- [ ] Data wipe (if any) is intentional and called out below

### Security / crypto / auth

<!-- Tick anything that applies. These trigger extra reviewer attention
     and gate the PR via CODEOWNERS where applicable. -->

- [ ] Auth flow change (OPAQUE, iron-session, 2FA)
- [ ] Encryption, key derivation, or share-secret handling
- [ ] New env var or secret (added to `packages/shared/src/env/env.config.ts`,
      configured in GitHub Environment, regenerated workflows via
      `pnpm generate:env`)
- [ ] New error code (registered in `error-codes.ts` AND `error-messages.ts`,
      covered by `error-messages.test.ts` completeness check)
- [ ] Rate limit added or modified
- [ ] New Zod boundary validation

### Operations scripts

<!-- If this PR's merge requires running an ops script (R2 CORS, for
     example), apply the matching `run-script:<name>` label.

     Type `run-script:` in the labels dropdown for autocomplete with
     descriptions. The full allowlist with phase metadata lives in
     `ops/manifest.yml`. An entry flagged `dispatch_only` there has no
     label, and the deploy refuses one applied by hand: a human runs it
     from Actions -> **Run ops script** (`ops/README.md` §Running a script),
     so name that run under Breaking changes / rollout instead of labelling.
     Adding a script requires CODEOWNERS approval; running one requires
     `production` environment approval, at merge or at dispatch. -->

- [ ] Tagged with one or more `run-script:<name>` labels (or none required)
- [ ] Any `dispatch_only` script this merge depends on is named under
      Breaking changes / rollout with its manual run sequenced against the deploy

### Breaking changes / rollout

<!-- Anything reviewers / future-you should know about merge timing,
     deploy ordering, removed features, or follow-up steps. -->

### Screenshots / recordings

<!-- For UI changes. Drag-and-drop into the PR description. -->
