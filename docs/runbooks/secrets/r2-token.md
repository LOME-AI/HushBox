# R2 S3 tokens

Obtain an R2 API token for each of the three pairs: the runtime media pair scoped to its buckets, the account-wide bucket-admin pair the ops runner alone holds, and the CI cassette pair scoped to its bucket. Both halves of a pair are set together and are coupled in the deploy. Design: `docs/SECRETS.md`.

## Obtain

An R2 API token is an S3-API credential and nothing else: an Object-level token is honoured
only by the S3-compatible endpoint, never by Cloudflare's REST API. That is why the deploy's
`wrangler r2 object` commands run on the account API token
(`docs/runbooks/secrets/cloudflare-api-token.md`) and on no pair here. Unlike an account API token, an
R2 token has no expiry field: an Account API token is valid until revoked, a User API token
until its user leaves the account.

Click path, the same for every pair, per [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/):

1. In the Cloudflare dashboard open **R2 object storage**.
2. Under **Account Details**, select **Manage** beside **API Tokens**.
3. Select **Create Account API token**. An Account API token is tied to the account and valid
   until revoked; viewing or creating one needs the Super Administrator role. A User API token
   dies with its user.
4. Name the token after the pair it becomes.
5. Under **Permissions**, choose the level the pair's heading names, spelled as the dashboard
   lists them: **Admin Read & Write**, **Admin Read only**, **Object Read & Write**, **Object
   Read only**.
6. For an Object level, a bucket-scoping step appears: select the buckets the pair's heading
   names. Admin levels are account-wide and offer no bucket step.
7. Select **Create Account API token**.
8. The next screen shows the **Access Key ID** and the **Secret Access Key** once; Cloudflare's
   own page calls them Client ID and Client Secret. Write the offline copy of both, then set
   the pair together under the names its heading gives.

### The runtime media pair: `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`

Level **Object Read & Write**, scoped to two buckets: the media bucket (`hushbox-media`, the
production `R2_BUCKET_MEDIA` in the env registry) and the model-weights bucket (the
`MODEL_WEIGHTS` binding in `apps/api/wrangler.toml`). The Worker reads, writes, deletes and
presigns objects in the media bucket through this pair; presigning needs no further
permission. The deploy's model-weights publish signs its existence probes against the
model-weights bucket with the same pair, and a pair scoped to the media bucket alone stops
that deploy step with an unreadable probe. Set both in the `production` environment, coupled
with `R2_S3_ENDPOINT`. Probe: the next deploy exercises the model-weights bucket at the
weights-publish step, and the first media upload after it exercises the media bucket.

### The bucket-admin pair: `R2_ADMIN_ACCESS_KEY_ID` and `R2_ADMIN_SECRET_ACCESS_KEY`

Level **Admin Read & Write**: bucket configuration (`PutBucketCors`) is granted only at the
Admin level, and Admin is account-wide, so this pair reaches every bucket in the account. That
reach is why it is read by the ops runner alone (the ops-script workflow and the deploy job's
ops steps) and never published to the Worker. Set both in the `production` environment.
Probe: run the CORS script by labelling a PR `run-script:configure-r2-cors` (`ops/README.md`);
it replaces the media bucket's CORS rule set wholesale with the same rules, so a re-run
changes nothing.

### The CI cassette pair: `CASSETTE_R2_ACCESS_KEY_ID` and `CASSETTE_R2_SECRET_ACCESS_KEY`

Level **Object Read & Write**, scoped to the cassette bucket. Set both in the `ci`
environment beside the two identifiers the store also reads there: `CASSETTE_R2_ACCOUNT_ID`
(the owning account's id, `docs/runbooks/secrets/cloudflare-identifiers.md`) and `CASSETTE_R2_BUCKET`
(the bucket name). Probe: the next CI test job; the cassette store throws on any refused
list, get or put, naming the operation and the status.

### The backup pair: `BACKUP_R2_ACCESS_KEY_ID` and `BACKUP_R2_SECRET_ACCESS_KEY`

Level **Object Read only**, scoped to the three buckets the backup run copies: media,
app-builds and model-weights. Read-only is the point — the backup run lists and reads,
and a stolen backup key must not be able to write or delete an object it copies. The
app-builds bucket is reached by no other pair here, so this is not a narrowing of the
runtime media pair. Set both in the `backup` environment, coupled with
`BACKUP_R2_S3_ENDPOINT` (the same account-scoped host as `R2_S3_ENDPOINT` below, held
separately because a `production` value is unreadable from the `backup` environment).
Probe: the next hourly backup run; its reconciliation refuses on any listing the store
would not serve. Design: `docs/BACKUPS.md`.

### `R2_S3_ENDPOINT`

No screen displays it; compose it from the account id as
`https://<account-id>.r2.cloudflarestorage.com`. A bucket created in a jurisdiction answers on
a jurisdiction host instead, with `eu`, `fedramp` or `us` inserted after the account id. Set
it in the `production` environment, coupled with the runtime pair. The cassette store and the
weights probe compose the same host from the account id themselves and hold no endpoint
secret.
