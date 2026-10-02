# Hookdeck API key

Obtain the Project API key the webhook CI lane opens its Helcim-sandbox tunnel with, and replace it by rolling it on the project's Secrets tab, which keeps the old value valid for a chosen window. Design: `docs/SECRETS.md`.

## Obtain

Vendor references: [Projects](https://hookdeck.com/docs/platform/event-gateway-projects) (the
Secrets tab and rolling), [Managing
environments](https://hookdeck.com/docs/use-cases/receive-webhooks/how-to-manage-environments),
and the `hookdeck/hookdeck-cli` repository's `README.md` §"Running in CI".

1. Sign in to the Hookdeck dashboard and select the project that holds the `helcim-sandbox`
   source, the source the lane listens on. Projects are Hookdeck's environment unit: there is
   no test/live switch, each project carries its own API key, and switching is "click the
   current organization name in the top left of the dashboard and select the desired project in
   the dropdown". To create one: click the organisation name, **Create Project** at the bottom
   of the dropdown, name it, choose the **Event Gateway** project type, **Create Project**.
   "Organization administrators can create both public and private projects. Organization
   members can only create private projects."
2. Open the project's **Settings**, then the **Secrets** tab (the CLI's own error text calls it
   **Project Settings > API Keys**). The **API Key** is displayed there beside the **Signing
   secret**; the docs describe the tab as where you "manage" both and call neither shown-once.
   Take the API Key: it is the Bearer token for Hookdeck's API, carries no scopes or permission
   tiers, and is limited to "240 request per minute, per API key". The signing secret verifies
   inbound deliveries by HMAC and is not this secret.
3. This is a **Project API key**, scoped to one project. It is not the **CLI key** that
   `hookdeck login` stores, which is tied to a user account and moves across projects; the CLI
   exchanges the project key for a project-scoped client key at `hookdeck ci`, and the result
   "cannot list or switch projects across your account".
4. Write the offline copy (`docs/SECRETS.md` §Rules), then set `HOOKDECK_API_KEY` in the `ci`
   GitHub environment; the e2e job's webhook lane in `.github/workflows/ci.yml` reads it.

A missing key is loud in one command and silent in the other. Established from the CLI's source
(`pkg/cmd/listen.go`, `pkg/cmd/ci.go`), stated in no Hookdeck document: `hookdeck ci` with an
empty key fails at once ("Provide a project API key using the --api-key flag"), while
`hookdeck listen` with no key attempts no authentication and runs on "a temporary guest account
... which has no delivery history, retries, or issue triggers", printing no error — a listener
that starts, forwards nothing the lane can verify, and looks like success. A wrong or expired
key fails loudly in both ("could not authenticate with HOOKDECK_API_KEY" from `listen`;
"Authentication failed: your API key is invalid or expired" from `ci`). The lane runs
`hookdeck ci` before `hookdeck listen`, which is what makes a missing key fail the job here
instead of running as a guest; `pnpm verify:evidence --require=helcim-webhook` then asserts a
delivery arrived and passed signature verification.

Probe:

```
pnpm exec hookdeck ci --api-key <key>
```

A live key prints `Done! The Hookdeck CLI is configured in project <name>`; confirm the name is
the project holding `helcim-sandbox`. Pass the key explicitly: the CLI's precedence is
`--cli-key`, then credentials stored by `hookdeck login` or `hookdeck ci`, then
`HOOKDECK_API_KEY`, so on a machine you have logged in from, the environment variable alone
probes your stored login instead.

**Replace or revoke.** Hookdeck calls it rolling: on the Secrets tab, open the **...** menu
beside the API Key and choose **Roll Key**; "you can select an expiration allowing for no
downtime rotation ... Both the old and the new secret will be valid during the transition
period." Set the rolled value in `ci` inside that window. The page describes the window for
both secrets on the tab, but its worked example of dual validity is the signing secret's
signature headers, not the API key's; confirm on the live project before relying on the window
for a zero-downtime swap. Under compromise, choose the shortest expiration the control offers —
whether an immediate cutover is among them was not established; the exposure is the sandbox
project's configuration and deliveries, no production credential.
