# Resend webhook signing secret

Obtain the signing secret by creating the bounce-and-complaint webhook endpoint, and replace it by creating a successor endpoint before deleting the old one: Resend documents no action that rotates an existing endpoint's secret. Design: `docs/SECRETS.md`.

## Obtain

Vendor reference: the dashboard's Webhooks page, [resend.com/webhooks](https://resend.com/webhooks).

1. Sign in to Resend, open **Webhooks**, then **Add Webhook**.
2. Endpoint URL: `https://api.hushbox.ai/newsletter/webhooks/resend`, the newsletter slice's
   webhook route on the production API origin (`apps/api/src/slices/newsletter/routes.ts`).
   Resend delivers by HTTPS `POST`.
3. Under "Select all events you want to observe" tick `email.bounced` and `email.complained`.
   Those are the two the route acts on; every other event is answered `200` and ignored
   (`apps/api/src/slices/newsletter/domain/webhook-verify.ts`), so subscribing more buys
   deliveries and changes nothing.
4. Create the endpoint. The signing secret is displayed on the endpoint's details page and
   returned as `signing_secret` by the create, retrieve and list API calls; it stays readable,
   so it is not a one-time display. Its shape is `whsec_` followed by standard base64. The
   Worker's verifier requires exactly that shape and throws at the first delivery otherwise; it
   verifies Resend's `svix-id`, `svix-timestamp` and `svix-signature` headers over the raw
   body with a 300-second timestamp tolerance, so anything between Resend and the Worker that
   re-serializes the body breaks verification.
5. Write the offline copy (`docs/SECRETS.md` §Rules), then set `RESEND_WEBHOOK_SECRET` in the
   `production` GitHub environment; the deploy publishes it to the Worker. Local and CI runs
   use a fixed non-secret value from the registry and sign their own deliveries; no CI job
   holds the production secret.

Probe: the first bounce or complaint delivery is answered `200` and the address is suppressed.
How to provoke a delivery on demand, and what the endpoint's details page shows of delivery
attempts and their response codes, could not be established from Resend's documentation; read
the details page after the first real bounce rather than waiting for a signal that may not
exist.

**Replace.** Resend's update call (`PATCH /webhooks/{id}`) changes only `endpoint`, `events`
and `status`, and neither the Webhooks page nor the verification guide names a rotate action;
that replacement is delete-and-recreate is inferred from the absence of any other operation in
the documented surface, not stated by Resend, so check the live Webhooks page for a rotate
control before assuming. Endpoints coexist, so: create a second endpoint at the same URL with
the same two events, set its secret, deploy, then delete the old endpoint at once. A delivery
from the old endpoint after the deploy is refused by the Worker. Under compromise, delete the
old endpoint first; a bounce during the gap is not delivered, and the address stays unsuppressed
until the next bounce.
