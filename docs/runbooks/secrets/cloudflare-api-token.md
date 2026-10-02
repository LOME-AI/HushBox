# Cloudflare API tokens

Obtain the deploy token and the Access-log reader token as custom Account API tokens carrying exactly the permission sets this file states, and replace either by creating a successor before deleting the old one. Under compromise, roll the token in place. Design: `docs/SECRETS.md`.

## Obtain

Both tokens are built the same way; only the permission set differs. Vendor references:
[Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
and the [API token permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

1. In the Cloudflare dashboard open **Manage Account -> API Tokens**. This creates an Account
   API token, which belongs to the account and outlives any one user. (**My Profile -> API
   Tokens** creates a user token, which deactivates when that user leaves the account and
   would take the deploy with it.)
2. Select **Create Token**, then **Custom Token**. The prebuilt "Edit Cloudflare Workers"
   template grants more than the set below (KV and D1 among it) and is reported insufficient
   for Pages; the table under each token is the whole grant.
3. Name the token after the GitHub secret it becomes.
4. Under **Permissions**, add one row per line of the token's table: choose the group
   (**Account**, **User** or **Zone**), then the permission, then the level. `Edit` is full
   create, read, update, delete and list; `Read` is read and list. Cloudflare's permissions
   reference lists every permission twice, once suffixed `Edit` and once `Write`, with the same
   description under both; the dashboard editor shows `Edit`, and `Write` is the name the same
   permission group carries in the token API.
5. Under **Account Resources**, choose **Include** and the HushBox account. Neither token needs
   a **Zone Resources** row as far as is established; the one open question is under the deploy
   token.
6. Leave **Client IP Address Filtering** and **TTL** at their defaults: GitHub-hosted runners
   have no fixed address, and an expiry nothing in the repository tracks would fail a deploy on
   a date. The concrete options behind those two fields could not be established from
   Cloudflare's documentation; read them on the screen rather than from this file.
7. Select **Continue to summary**, check the rows against the table, then **Create Token**.
8. The token value is displayed once, on the completion screen, prefixed `cfut_` so credential
   scanners recognise it. Write the offline copy, then set the GitHub secret named under the
   token's heading in the `production` environment.

The completion screen also shows a ready-made `curl` verify command; run it. A live token
answers `"status": "active"` and `"success": true`. That proves the token is active and nothing
about its permissions; each token's functional probe is under its heading.

### The deploy token: `CLOUDFLARE_API_TOKEN`

| Group   | Permission         | Level | What runs on it                                                                                                                                                                                                                                                                                    |
| ------- | ------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account | Workers Scripts    | Edit  | `wrangler deploy` for the product, admin and sandbox Workers, the product Worker's secrets in its upload, and the deploy's reads of those Workers: `wrangler secret list` and the live-version reads of the order guard and the surface probe. Worker secrets are governed by this one permission. |
| Account | Workers R2 Storage | Edit  | `wrangler r2 object get` and `put`: the OTA-bundle guard and upload on the app-builds bucket, and the model-weights publish. These ride Cloudflare's REST API, which an R2 API token cannot serve (`docs/runbooks/secrets/r2-token.md`).                                                           |
| Account | Cloudflare Pages   | Edit  | `wrangler pages deploy` for the web app. `Read` fails it with an authentication error.                                                                                                                                                                                                             |
| Account | Account Settings   | Read  | Wrangler's account resolution at the start of every command.                                                                                                                                                                                                                                       |
| User    | User Details       | Read  | Open. Cloudflare names it as the fix for a deploy failing with "Unable to retrieve email for this user"; whether the non-interactive deploy job ever makes that lookup is unestablished. The token carries it until a deploy under a token without it is proven.                                   |

Open, zone level: the Wrangler configurations declare zone routes on `hushbox.ai`
(`admin.hushbox.ai/api/*` for the product Worker, `admin.hushbox.ai/*` for the admin Worker)
and a custom domain (`sandbox.hushbox.ai` for the sandbox Worker). Whether `Workers Scripts:
Edit` applies those at deploy or the token also needs **Zone -> Workers Routes -> Edit** on
`hushbox.ai` (and, for the custom domain, the DNS and certificate permissions Cloudflare
requires for a Worker custom domain) is unestablished. Build the token without a zone row: a
token short of it fails the deploy step that attaches the route, loudly and after the script
upload, and the refusal names what to add. The product apex `api.hushbox.ai` is a
dashboard-configured custom domain the deploy never touches.

Set as `CLOUDFLARE_API_TOKEN` in the `production` environment. Probe: the next production
deploy runs every command in the table; a permission the token lacks fails the job at that
command.

### The Access-log reader token: `CLOUDFLARE_ACCESS_LOG_API_TOKEN`

| Group   | Permission         | Level | What runs on it                                                                                                              |
| ------- | ------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| Account | Access: Audit Logs | Read  | The admin plane's Access-log auditor: `GET /accounts/<account id>/access/logs/access_requests`, the account-scoped endpoint. |

This permission is read-only by design and has no `Edit` counterpart. It is distinct from
`Access: Organizations, Identity Providers, and Groups` (Access configuration) and from
`Logs: Read` (Logpull, Logpush and Instant Logs); neither serves the endpoint.

Set as `CLOUDFLARE_ACCESS_LOG_API_TOKEN` in the `production` environment; the deploy publishes
it to the Worker beside `CLOUDFLARE_ACCOUNT_ID` (`docs/runbooks/secrets/cloudflare-identifiers.md`).
Probe:

```
curl "https://api.cloudflare.com/client/v4/accounts/<account-id>/access/logs/access_requests" \
  --header "Authorization: Bearer <token>"
```

A correctly scoped token answers `"success": true` with a `result` array, empty when nobody has
authenticated inside the retention window (24 hours on the free Access tier).
