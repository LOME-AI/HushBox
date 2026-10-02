# Helcim credentials

Obtain the three Helcim values — the API access token, the webhook verifier token, and the publishable Helcim.js configuration token — from the production merchant account and again from the sandbox account CI uses, and replace the API token and the Helcim.js token by generating successors; Helcim documents no way to replace the verifier token. The Helcim.js token is compiled into every bundle, so native clients carry the old one until they take the next over-the-air update. Design: `docs/SECRETS.md`.

## Obtain

Two accounts hold the same three values. The production merchant account feeds the `production`
GitHub environment under the `*_PRODUCTION` names; a separate sandbox account, provisioned by
emailing `tier2support@helcim.com` from the production account, feeds the `ci` environment under
the `*_SANDBOX` names. The Worker calls `https://api.helcim.com/v2` under both tokens; no
sandbox host is configured (`apps/api/src/slices/billing/adapters/payment-helcim.ts`), and only
the token differs. Vendor references: [API access
configurations](https://devdocs.helcim.com/docs/creating-an-api-access-configuration) and
[Helcim.js configurations](https://devdocs.helcim.com/docs/creating-a-new-config).

### The API access token: `HELCIM_API_TOKEN_PRODUCTION` / `HELCIM_API_TOKEN_SANDBOX`

1. **All Tools -> Integrations -> API Access Configurations -> New API Access**.
2. Name the configuration after the GitHub secret it becomes. Leave the HelcimPay.js checkbox
   clear: the card form uses Helcim.js and the Payment API, not HelcimPay.js.
3. Under **Access Restrictions** set the three dropdowns. Helcim spells them **General**
   ("general objects like Customers, Invoices, Products"), **Settings** ("settings objects like
   VT Settings, Customer settings, General settings"), and **Transaction Processing**
   ("transaction processing through the Payment API and HelcimPay.js"). Transaction Processing
   has four cumulative levels — **None**, **Auth** (verify and preauth), **Positive
   Transaction** ("Can processing purchase, capture, and withdrawal transaction types."), and
   **Admin** (adds refund and reverse). The Worker issues `POST /payment/purchase` and reads
   `GET /card-transactions`, and never refunds or reverses
   (`apps/api/src/slices/billing/ports/payment-provider.ts`), so **Positive Transaction** is the
   level the purchase needs and **Admin** grants what nothing uses. Which dropdown and level
   governs the transaction reads is unestablished: Helcim's reference lists the endpoints with
   no permission mapping. General and Settings show the levels **No access**, **Read** and
   **Read & Write**; whether the dropdowns hold a level the page never names is unestablished.
   Build with General **Read**, Settings **No access**, Transaction Processing **Positive
   Transaction**, then run the probe and a purchase; if the transaction read is refused, raise
   General one level and retry. Helcim's own broad recommendation, General **Read & Write**,
   Settings **Read & Write**, Transaction Processing **Admin**, is a general-purpose grant, not
   a minimum.
4. **Create** (top right) saves the configuration and generates the token. Whether the value
   stays readable afterwards is not stated; Helcim's advice to "obscure all but the last four
   digits of your API token value in screenshots" suggests it does, but treat the creation
   screen as the one display and write the offline copy there (`docs/SECRETS.md` §Rules).
5. Set the GitHub secret. The deploy publishes the production value to the Worker as
   `HELCIM_API_TOKEN`, coupled with the verifier token below; the end-to-end CI job reads the
   sandbox value.

Probe:

```
curl "https://api.helcim.com/v2/connection-test" --header "api-token: <token>"
```

A live token answers `{"message": "Connected Successfully"}`. That proves the token, not its
levels; the level probe is a purchase — in CI the end-to-end lane charges the sandbox and
`pnpm verify:evidence --require=helcim` asserts the call happened; in production, one real
card top-up.

**Replace or revoke.** **All Tools -> Integrations**, select the configuration, then the
**Actions** menu in the top right corner and "the appropriate option"; Helcim does not name the
items, so whether the token regenerates in place or a fresh configuration is created is read
off the live menu. Either way the value changes: set the secret and deploy, and publish the
verifier beside it because the two are coupled. Under compromise, disable there first; Helcim
also recommends changing the account passwords and auditing user access afterwards.

### The webhook verifier token: `HELCIM_WEBHOOK_VERIFIER_PRODUCTION` / `HELCIM_WEBHOOK_VERIFIER_SANDBOX`

1. **All Tools -> Integrations -> Webhooks**, toggle **Webhooks ON**.
2. **Deliver URL**, production: `https://api.hushbox.ai/billing/webhooks/payment`, the billing
   slice's webhook route (`apps/api/src/slices/billing/routes.ts`); Helcim requires `https` and
   states the URL "cannot contain the word 'Helcim'". Sandbox: the CI lane receives deliveries
   through a Hookdeck source and forwards them to the same path, so the sandbox account's
   Deliver URL is that source's URL (`docs/runbooks/secrets/hookdeck-key.md`).
3. Select the card-transaction and dispute events, then **Save**. The route recognises the
   event types listed in `apps/api/src/slices/billing/domain/payments/webhook-verify.ts` and
   ignores others; the labels Helcim's page gives those events were not established.
4. The `verifierToken` is displayed in the webhooks settings section and stays readable. Its
   value is standard base64: the Worker decodes it at construction and throws otherwise, then
   verifies `webhook-signature` as HMAC-SHA256 over `webhook-id`, `webhook-timestamp` and the
   raw body under the decoded bytes. Write the offline copy and set the GitHub secret; the
   deploy publishes the production value as `HELCIM_WEBHOOK_VERIFIER` in the same publish as
   the API token. The production value is escrowed, and that deploy's run captures it before
   it publishes anything (`docs/runbooks/secrets/backblaze-key.md`). The sandbox value has its offline
   copy and nothing else — the escrow binds the `production` environment only — so a sandbox
   value lost with its copy is a support request against the sandbox account.

Probe: after one purchase the webhook verifies and the credit lands — the card form polls the
balance for it. In CI, `pnpm verify:evidence --require=helcim-webhook` asserts a delivery
arrived and passed signature verification.

**Replace.** Helcim documents no rotation for this value: not on the webhooks page, not in the
API-token security guidance, and not in the API reference. Whether the **Actions** menu or
toggling **Webhooks** off and on regenerates it is unestablished; read the live page. If
nothing there regenerates it, replacing a compromised verifier is a Helcim support request, and
until then the route's exposure is forged payment events, which cannot mint credit
(`docs/SECRETS.md` inventory). However the replacement is obtained, it goes live only through
a deploy, and that deploy's escrow job captures it before the publish.

### The Helcim.js configuration token: `VITE_HELCIM_JS_TOKEN_PRODUCTION` / `VITE_HELCIM_JS_TOKEN_SANDBOX`

1. **All Tools -> Integrations -> Helcim.js Configurations -> New Configuration**.
2. **Website URLs**: every origin the card form loads from — the web app's, and the origin each
   native WebView presents; which origins Helcim accepts for a native shell was not established.
3. **Transaction type**: card verify. This setting is the whole safety argument, below.
4. **Currency**, **Minimum/Maximum Amount** and **reCAPTCHA v3** are the throttles Helcim
   offers against the abuse the token permits; set the amount bounds to the deposit bounds.
5. **Save** generates the token and a secret key the code does not use. Whether the token stays
   readable afterwards is not stated; write the offline copy on the creation screen.
6. Set the GitHub secret once, at repository scope: `VITE_HELCIM_JS_TOKEN_PRODUCTION` and
   `VITE_HELCIM_JS_TOKEN_SANDBOX` both, because one declaration governs the two names and a
   job reads repository-scoped secrets whatever environment it declares. The repository
   copy is the only copy: delete any environment-scoped copy of either name. The value is
   compiled into the web bundle and the mobile bundles, not published as a Worker secret.

Why a token compiled into public bundles is acceptable, and on what condition: the Worker
charges server-side with the API token, passing the `cardToken` the form read back; the form
reads back only `cardToken`, `cardType`, the card's last four and `customerCode`
(`apps/web/src/lib/billing/helcim-loader.ts`). Under a card-verify configuration Helcim.js runs
a $0.00 verify, so the worst a holder of the token can do is card-testing $0.00 verifies against
the merchant account and tokenizing cards they already hold; they cannot move money without the
API token. The condition is the configuration's type: the form submits a hidden `amount` field
alongside the card (`apps/web/src/components/billing/payment-form.tsx`), so a purchase-type
configuration would charge client-side on an amount the client chose and the Worker would
charge the token again. Helcim's own guidance is the same pattern: "we recommend combining
Helcim.js to complete a card verify, with the Payment API to process purchase transactions."
That a purchase-type configuration's token could not be abused for purchases is not something
Helcim states, which is why the type is checked, never assumed.

Probe: a card top-up completes on a fresh build; in CI, the end-to-end lane runs one against the
sandbox.

**Replace.** Create a new configuration, set the repository-scoped secret, deploy the web
bundle and ship the mobile bundles. Delete the old configuration only after native clients have
taken the over-the-air update: a native card form still carrying the old token fails until it
does. Under compromise, delete first and accept that native card forms fail until the update.
