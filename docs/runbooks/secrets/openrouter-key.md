# OpenRouter API keys

Obtain the production inference key and the spend-restricted CI key as two API keys on one OpenRouter account, differing only in the credit limit set at creation, and replace either by creating a successor before deleting the old one. Design: `docs/SECRETS.md`.

## Obtain

Vendor references: the Keys page, [openrouter.ai/keys](https://openrouter.ai/keys), and
[Management API keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys).

1. Sign in to OpenRouter and open **Keys**. Select the create control (third-party walkthroughs
   name it **Create Key**; OpenRouter's own page states only the outcome).
2. Name the key after the GitHub secret it becomes.
3. "Give it a name and you can optionally set a credit limit." The limit is a USD ceiling on the
   key's spend and is the only restriction a key itself carries. The API adds `limit_reset`
   (`daily`, `weekly`, `monthly`, or none; resets at midnight UTC), `expires_at`, and
   `include_byok_in_limit`; whether the creation dialog exposes the reset cadence was not
   established, so set it through the Management API if the dialog lacks it.
4. Create the key. The value is displayed once ("only shown once"); every later read returns a
   truncated label and the key's hash. Shape: `sk-or-v1-` followed by 64 lowercase hex
   characters.
5. Write the offline copy (`docs/SECRETS.md` §Rules), then set the GitHub secret named under the
   key's heading.

Model and provider scoping is not a key field. It is a separate **Guardrail** — **Settings ->
Privacy -> Guardrails -> New Guardrail** (an OpenRouter post describes a newer **Workspaces ->
Guardrails** path; read the live console) — carrying `allowed_models`, `allowed_providers` and a
budget of its own, assigned to a key; one guardrail per key, and "Individual API key budgets
still apply. The lower limit wins." The repository records no guardrail on either key; the
per-key limit is the CI key's whole restriction.

Probe, for either key, costs nothing:

```
curl "https://openrouter.ai/api/v1/key" --header "Authorization: Bearer <key>"
```

A live key answers with its `label`, `limit`, `limit_remaining` and `usage`; for the CI key,
confirm `limit` is the ceiling intended.

### The production key: `OPENROUTER_API_KEY_PRODUCTION`

Set in the `production` environment; the deploy publishes it to the Worker as
`OPENROUTER_API_KEY`. Whether it carries a limit is an
operator choice nothing in the code reads. Functional probe after the deploy: one chat turn
completes and bills.

### The CI key: `OPENROUTER_API_KEY_RESTRICTED`

Set in the `ci` environment; the vitest job reads it. Its limit is what "spend-restricted"
means. A green CI run does not prove this key: AI calls replay from cassettes while the request
is unchanged, and the evidence gate accepts a warm-cassette replay for OpenRouter
(`docs/CI-CASSETTES.md` §What `verify:evidence --require=openrouter-inference` proves), so the
`curl` above is the only probe that exercises the key itself.

**Replace or revoke.** Keys coexist: create the successor, set the secret, deploy (or let the
next CI run pick it up), then delete the old key on the Keys page. With a management key,
`DELETE /api/v1/keys/{hash}` deletes and `PATCH /api/v1/keys/{hash}` with `disabled: true`
disables reversibly. Management keys are a separate class — **Settings -> Management keys**
([openrouter.ai/settings/management-keys](https://openrouter.ai/settings/management-keys)) ->
**Create New Key** — that cannot call inference and exist to create, read, update and delete
API keys; OpenRouter names key rotation as their use case. None is a repository secret: hold
one offline or do not create one.
