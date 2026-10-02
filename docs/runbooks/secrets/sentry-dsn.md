# Sentry DSN

Obtain the DSN of a client key on the backend Sentry project, and replace it by adding a second client key before deleting the first; a DSN is write-only, so exposure costs event spam, never data. Design: `docs/SECRETS.md`.

## Obtain

Vendor reference: [What is a DSN](https://docs.sentry.io/concepts/key-terms/dsn-explainer/).

1. In Sentry open the backend project, then **Settings -> SDK Setup -> Client Keys (DSN)**
   (URL shape `sentry.io/settings/<org>/projects/<project>/keys/`).
2. Each client-key row shows its DSN; the value stays readable, so it is never a one-time
   display. A project holds several client keys at once: Sentry's API creates one with
   `POST /api/0/projects/{org}/{project}/keys/` under a token with `project:write` or
   `project:admin`, and the list endpoint is plural. The dashboard's control for adding one is
   reported as **Add New Client Key** but was not verified against the live page.
3. The DSN shape is `{PROTOCOL}://{PUBLIC_KEY}@{HOST}{PATH}/{PROJECT_ID}`; the older
   `:{SECRET_KEY}` component is "optional and effectively deprecated", so set the public-key
   form. The Worker's transport posts envelopes to the DSN's ingest URL with the key in the URL
   (`apps/api/src/lib/telemetry/adapters/sentry-adapter.ts`).
4. Write the offline copy (`docs/SECRETS.md` §Rules), then set `SENTRY_DSN` in the `production`
   GitHub environment; the deploy publishes it to the Worker. The sink factory throws when the
   value is empty while the `sentry` sink is configured
   (`apps/api/src/lib/telemetry/request-telemetry.ts`), so a missing DSN fails loudly rather
   than dropping events. No CI job holds it.

Why exposure is a nuisance and not a breach, in Sentry's words: "DSNs are safe to keep public
because they only allow submission of new events and related event data" and "they do not
allow read access to any information." A holder can spam events against the quota; the remedy
is the replacement below.

Probe: nothing in the repository raises a test event, so the probe is the next captured defect
appearing in the project after the deploy, counted on the new key's row. Captures are
best-effort: a wrong DSN loses events and blocks no request.

**Replace or revoke.** Add a second client key, set its DSN, deploy, confirm on the Client Keys
page that the old key's event count has stopped rising, then delete or disable the old key.
Sentry states that DSNs can be rotated and revoked from this page and documents nothing about
events in flight at the moment a key is revoked; no grace period or refusal behaviour is stated
either way. Under compromise, revoke first and redeploy after; the gap costs visibility only.
