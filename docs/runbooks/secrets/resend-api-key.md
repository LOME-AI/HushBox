# Resend API key

Obtain the email-sending key by creating an API key on the Resend account at **Sending
access** restricted to the sending domain (§Obtain), and replace it by creating a successor
before deleting the old one. Design: `docs/SECRETS.md`.

## Obtain

Vendor references: the dashboard's API Keys page, [resend.com/api-keys](https://resend.com/api-keys),
its guide, [resend.com/docs/dashboard/api-keys/introduction](https://resend.com/docs/dashboard/api-keys/introduction),
and the create-key reference,
[resend.com/docs/api-reference/api-keys/create-api-key](https://resend.com/docs/api-reference/api-keys/create-api-key).

A key sends only from a domain the account has verified. Verifying the adapter's sending domain
is under "The sending domain" below; do it first on a fresh account.

1. Sign in to Resend, open **API Keys**, then **Create API Key**.
2. Name the key after the GitHub secret it becomes.
3. Choose the permission: **Sending access**. Resend offers exactly two, a key carries exactly
   one of them, and no narrower tier sits between them:
   - **Full access** (`full_access` in the API): "Can create, delete, get, and update any
     resource." It sends, reads every sent email and the account's email history, and creates
     and deletes domains, webhooks and other API keys. It cannot be restricted to a domain.
   - **Sending access** (`sending_access`): "Can only send emails." It can be restricted to one
     domain. Every other call, a read of a sent email included, is refused with HTTP 401
     `restricted_api_key`, "This API key is restricted to only send emails".

   The code path that holds the key calls only the send and batch-send endpoints
   (`apps/api/src/slices/notifications/adapters/email-resend.ts`), so **Sending access**
   covers everything it does, and it is the only tier a domain restriction can narrow.

4. Restrict the key to the sending domain. The restriction must cover
   every `from` address the adapter sends; its default sender is `noreply@mail.hushbox.ai`
   (`email-resend.ts`), and a send from outside the restriction is refused.
5. Create the key. The value is displayed once: "You cannot view or edit an API key value after
   it has been created." Its shape begins `re_`.
6. Write the offline copy (`docs/SECRETS.md` §Rules), then set `RESEND_API_KEY` in the
   `production` GitHub environment; the deploy publishes it to the Worker. Local and CI runs
   use the in-process mock sender and never hold
   this key (`apps/api/src/slices/notifications/adapters/email-sender-factory.ts`); the CI test
   jobs never read the secret, and the deploy job reads it only to publish it.

Probe, before the deploy, with the body shape the adapter sends:

```
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"from":"HushBox <noreply@mail.hushbox.ai>","to":"<a mailbox you read>","subject":"probe","html":"<p>probe</p>"}'
```

A working key answers HTTP 200 and the message arrives; the send also appears on the dashboard's
Emails page. The same send confirms the key carries **Sending access**:
`GET https://api.resend.com/emails/<id>`, with the id Resend returns for the send, answers 401
`restricted_api_key`; a 200 means the key was created at **Full access** — replace it under
"Replace or revoke" below. After the deploy,
the functional probe is a newsletter subscription from a test address on the production site:
its double-opt-in confirmation is sent through this key and must arrive.

**The sending domain.** Vendor reference:
[resend.com/docs/add-a-domain](https://resend.com/docs/add-a-domain). Open **Domains**, then
**Add Domain**; enter the domain (Resend recommends a subdomain over the root, and each
subdomain is verified on its own); choose a region; optionally set a custom Return-Path
subdomain (the default is `send.` under the domain). The domain's **Records** tab then lists
the DNS records to create. Resend's page states only the record categories, "the DKIM and SPF
configurations (`TXT` and `MX` or `CNAME` records)"; the hosts and values are generated per
domain, are read from that Records tab, and "must match exactly what Resend generated". A
proxied CNAME (Cloudflare's orange cloud) blocks verification. Verification typically completes
within 15 minutes and can take up to 72 hours of propagation; **Restart verification** exists if
it stalls. A DMARC record is recommended afterwards and does not block sending. Third-party
summaries describe the hosts as an MX and an SPF `TXT` at a `send` host, and DKIM as either one
`resend._domainkey` `TXT` or three per-domain CNAMEs; Resend's own page does not, so treat the
Records tab as the only authority and never a pattern copied from here.

**Replace or revoke.** Keys coexist. Create the successor at **Sending access** with the same
domain restriction; write the offline copy; set the secret; deploy; run the
post-deploy probe and confirm the successor's row on the API Keys page shows a request (each
row carries a running request count, and clicking it opens that key's logs); then remove the
old key from its row's **More options** menu, **Remove API key**, or `DELETE` it through the
API-keys endpoint. Under compromise, remove the old key first: every send between the removal
and the deploy fails, a transactional send is best-effort and never retried (`email-resend.ts`),
so those emails are lost, and a newsletter batch is retried by the dispatch job's own attempt
loop.
