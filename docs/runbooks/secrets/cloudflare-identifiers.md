# Cloudflare identifiers

Obtain the non-secret Cloudflare values held as GitHub secrets because they differ per environment: the account id, the Access team name and the admin application's audience tag, the admin actor allowlist and the admin role map. Replacement is re-reading the value or re-editing the list; nothing is minted. Design: `docs/SECRETS.md`.

## Obtain

Every dashboard path below is written with **Zero Trust** as its first click, the label every
Cloudflare page the research read still uses. The product is being renamed Cloudflare One and
the dashboard URL already lives under `/one/zero-trust`, so the live label may read
**Cloudflare One**. Write each value's offline copy before setting it (`docs/SECRETS.md`
§Rules).

### `CLOUDFLARE_ACCOUNT_ID`

Any of three places, per [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/):

- **Account home** -> **Search** (`Ctrl`/`Cmd`+`K`) -> type `Copy account ID` -> select the result.
- **Workers & Pages** -> **Account Details** -> the copy button beside **Account ID**.
- Any domain -> **Overview** -> the **API** section at the foot of the page -> **Account ID**.

Shape: a hexadecimal string. It also composes the R2 S3 endpoint (`docs/runbooks/secrets/r2-token.md`).
Set as `CLOUDFLARE_ACCOUNT_ID` in the `production` environment: the deploy reads it for every
`wrangler` command and publishes it to the Worker for the Access-log auditor's API path.
`CASSETTE_R2_ACCOUNT_ID` in the `ci` environment is the id of the account owning the cassette
bucket, read the same way. Probe: the next deploy, whose every `wrangler` command addresses
this account.

### `CF_ACCESS_AUD`

**Zero Trust** -> **Access controls** -> **Applications** -> **Configure** on the admin
application, the one Access app fronting `admin.hushbox.ai`
(`apps/api/src/slices/admin/CLAUDE.md` §The edge and break-glass). Where the tag is displayed
is contested: Cloudflare's own JWT-validation page (as of 2026-05) puts **Application Audience
(AUD) Tag** on the **Additional settings** tab; third-party guides put it on the **Overview**
tab, which reflects an older layout. Look on **Additional settings** first.

Shape: a long lowercase hexadecimal string, the `aud` claim of every JWT the application
issues. It changes only when the application is deleted or recreated, which is also the only
event that requires re-reading it. Set as `CF_ACCESS_AUD` in the `production` environment,
coupled with `CF_ACCESS_TEAM_DOMAIN`.

### `CF_ACCESS_TEAM_DOMAIN`

The value is the team name alone, the part before `.cloudflareaccess.com`: the Worker appends
that suffix to build the JWT issuer and the JWKS URL, so a full domain here builds a wrong
issuer and every admin request fails. Where the team name is set is contested across three
official Cloudflare sources: **Zero Trust -> Settings**, with the team name and derived domain
shown on that page; **Zero Trust -> Settings -> Team name and domain -> Team name**; and
**Zero Trust -> Custom pages -> Team name and domain**, which is where the name is displayed on
login and block pages rather than where it is set. The `iss` claim of any JWT the application
issues is `https://<team-name>.cloudflareaccess.com` and reads the same value.

Set as `CF_ACCESS_TEAM_DOMAIN` in the `production` environment, coupled with `CF_ACCESS_AUD`.
Probe for the pair: after the deploy, sign in to the admin SPA; a wrong value in either answers
401 on every admin route. A wrong team name also fails the deploy's admin surface check, which
requires an unauthenticated admin request to redirect to exactly
`<team-name>.cloudflareaccess.com` (`scripts/verify-deployed-surfaces.ts`), so the release stays
untagged. A wrong `CF_ACCESS_AUD` passes that check and shows only at sign-in.

### `ADMIN_ACTOR_ALLOWLIST`

Our own list; no vendor issues it. Its format is fixed by the one parser,
`apps/api/src/lib/context/admin-allowlist.ts`: email addresses separated by commas. Each entry
is trimmed and lowercased before comparison, so spacing and case are free; an empty entry is
dropped; a list that parses to no address fails every admin route and every admin-operation
notification. Each address must be one the Access application's own policy admits: the
in-Worker check mirrors that policy, and an address present in one and absent from the other
is refused at whichever wall lacks it. Every address also needs an `ADMIN_ROLE_MAP` entry,
and that map's operator subset is who receives the notifications. Exact addresses only,
never a domain rule.

Set as `ADMIN_ACTOR_ALLOWLIST` in the `production` environment. Its loss class is
restoration from the offline copy, so the copy is written first; it is also escrowed, and the
deploy that publishes it captures it first (`docs/runbooks/secrets/backblaze-key.md`). Probe: an allowlisted
operator reaches the admin SPA; an address absent from the list is answered 401.

### `ADMIN_ROLE_MAP`

Our own list; no vendor issues it. Its format is fixed by the one parser,
`apps/api/src/lib/context/admin-allowlist.ts`: `address=role` pairs separated by commas,
the role one of the closed set in `packages/shared/src/admin/roles.ts` (`operator` is the
full plane; `growth-viewer` reads the growth pages and nothing else). An entry naming no
role, or a role outside that set, is dropped rather than defaulted, and the in-Worker
check refuses an allowlisted address this map has no entry for — so a malformed entry
fails closed as "configured with nobody". A map that parses to no roles fails every
admin route. The operator subset of the map is who receives the operation notifications
and the daily digest.

Set as `ADMIN_ROLE_MAP` in the `production` environment together with
`ADMIN_ACTOR_ALLOWLIST`; the two are coupled and ship in one publish. Probe: an address
mapped `operator` reaches every admin page; one mapped `growth-viewer` reaches the Growth
page and is refused elsewhere.
