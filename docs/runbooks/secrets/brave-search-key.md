# Brave Search API keys

Obtain the two Brave Search API keys web search runs with: the production key, from the Brave account that has zero data retention enabled, and the restricted CI key, from a separate Brave account that only CI uses. Each key is its own GitHub secret, and both reach code as the registry entry `BRAVE_SEARCH_API_KEY`. Replace either key in the order §Replace gives. Design: `docs/SECRETS.md`.

## Obtain

Vendor references: the Brave Search API dashboard,
[api-dashboard.search.brave.com](https://api-dashboard.search.brave.com), the
[web search API reference](https://api-dashboard.search.brave.com/api-reference/web/search/get),
and Brave's
[zero data retention announcement](https://brave.com/blog/search-api-zero-data-retention/).

1. Sign in to the dashboard as the account the key is for. The key's section below names that
   account.
2. Create an API key. Brave's reference pages do not name the creation control, and they do
   not say whether the value can be viewed again. Treat it as shown once.
3. Write the offline copy (`docs/SECRETS.md` §Rules), then set the GitHub secret named under the
   key's heading.

Local stacks never hold a Brave key: development, test and E2E use the placeholder
`mock-brave-search-key`, and the fake search adapter answers.

Probe, for either key:

```
curl "https://api.search.brave.com/res/v1/web/search?q=brave+search&count=1&result_filter=web" \
  --header "Accept: application/json" \
  --header "X-Subscription-Token: <key>"
```

A live key answers HTTP 200 with a `web.results` array. Brave bills successful requests
only, so a passing probe costs one search. Any other status means the key cannot search.
The error body's `error.code` names the cause, and `QUOTA_LIMITED` means the account's credit
or quota is spent. A 200 proves the key works. It does not prove that the key's account has
zero data retention.

### The production key: `BRAVE_SEARCH_API_KEY_PRODUCTION`

Create it while signed in to the Brave account that has zero data retention enabled. Brave
turns that setting on per account through its API support, as its announcement states. No
request parameter, header or response field asks for the setting or reports it. So the
account this key belongs to is the whole of the guarantee that Brave keeps no user's search.
A key from any other account searches exactly the same way and raises no alert, but it breaks
the privacy policy's statement about Brave's retention.

Set it in the `production` environment. The deploy publishes it to the Worker as
`BRAVE_SEARCH_API_KEY` in its one `wrangler secret bulk` call. Functional probe after the
deploy: a signed-in chat turn with web search on answers with web sources cited. Sentry shows
no fresh event whose `errorCode` tag is `search_provider_auth` or `search_provider_quota`.

### The CI key: `BRAVE_SEARCH_API_KEY_RESTRICTED`

Create it while signed in to a separate Brave account that only CI uses; that account is what
"restricted" means, since Brave documents no spend limit on a key itself. The account needs no
zero data retention, because the CI test sends only its own fixed query and never a user's.
Set it in the `ci` environment. Only non-pull-request CI runs read it.
Pull-request runs search through the fake adapter and hold no key. The Brave integration test
reaches Brave through the cassette layer. The first run records the response to the fixed
query, and later runs replay that recording without contacting Brave. The recording is keyed
without the token header, so a replaced CI key replays the same recording. A green run
therefore does not prove the key. Its `verify:evidence --require=brave-search` step does not
prove it either, because that gate counts a replay as evidence (`docs/CI-CASSETTES.md`). The
`curl` above is the only check that exercises the key.

## Replace

When the production key stops working, each web-search turn still completes and answers
without search results. Sentry is where the failure shows, under the event's `errorCode` tag.
The Brave adapter captures `search_provider_auth` when Brave refuses the key (HTTP 401 or 403,
or Brave's `SUBSCRIPTION_TOKEN_INVALID` code at any status).
It captures `search_provider_quota` when the account's credit or quota is spent (HTTP 402, or
Brave's `QUOTA_LIMITED` code). The first calls for a replacement key. The second calls for
credit on the same account, with no key change. `search_provider_unavailable` is not a key
fault: it is a Brave outage, or Brave rejecting HushBox's own request (any other non-2xx),
which calls for a code fix. A key from an account without zero data retention raises none of
these codes.

Brave's pages do not establish whether one account can hold two live keys at once. If the
dashboard lets you create the successor while the old key stands:

1. Create the successor by §Obtain under the same account, and write its offline copy.
2. Set it in the environment it replaces.
3. Deploy for the production key. For the CI key, the next non-pull-request run reads it.
4. Run the probe, then revoke the old key on the dashboard.

If the dashboard does not allow a second key, revoking the old key comes first. From the
revocation until the deploy carrying the successor, web search answers without results and
Sentry records `search_provider_auth`. Under compromise, revoke first either way.
