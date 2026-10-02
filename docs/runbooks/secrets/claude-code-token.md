# Claude Code OAuth token

Obtain the subscription OAuth token the board-grooming workflow runs the Claude Code agent with, and replace it by minting a successor; no revocation of the old token is documented, and deleting the GitHub secret does not revoke it. Design: `docs/SECRETS.md`.

## Obtain

Vendor references: [Authentication](https://code.claude.com/docs/en/authentication) §"Generate a
long-lived token", and [GitHub Actions](https://code.claude.com/docs/en/github-actions) §"Add an
authentication secret", §"Set up for an organization" and §"Uninstall".

1. On a machine with a browser (or one reachable through the CLI's copy-paste-code fallback),
   run:

   ```
   claude setup-token
   ```

   It opens the same browser authorization flow as `/login`; approve as the account whose
   subscription the workflow will spend, and the token prints to the terminal. It is saved
   nowhere, so copy it from the terminal. The account needs a Pro, Max, Team or Enterprise
   plan.

2. The value is an OAuth token, not a Console API key: it "is tied to the subscription of the
   person who ran `claude setup-token`", every run spends that person's plan quota rather than
   API billing, and it can make model requests only — no Remote Control sessions, no claude.ai
   connectors. It lives one year. Its literal prefix is reported as `sk-ant-oat01-` in issue
   titles on Anthropic's repositories; no Anthropic document states it.
3. Write the offline copy (`docs/SECRETS.md` §Rules), then set `CLAUDE_CODE_OAUTH_TOKEN` in the
   `linear` GitHub environment of the staging repository. The grooming workflow
   (`.github/workflows/groom-linear.yml`) runs only there, on a version-pinned Claude Code CLI
   with the variable in the groom job's environment.

Probe, locally, at the cost of one request against the subscription:

```
CLAUDE_CODE_OAUTH_TOKEN=<token> claude -p 'Reply with the single word ok'
```

A session given the variable authenticates with it instead of the saved login, so the reply
proves the token, not your own sign-in. In CI, dispatch **Groom Linear** with `dry_run` left at
`true`: the groom job's `claude -p` call is the proof — but preflight skips the run when the
board has no ungroomed issue and the commit scan finds nothing, and a skipped run proves
nothing.

**Replace or revoke.** Running `claude setup-token` again mints a second token and leaves the
first valid; set the successor and the workflow's next run uses it. Nothing documented ends the
old one. The CLI has no list or revoke command (requested in anthropics/claude-code#48373, open,
and anthropics/claude-code#57400, closed as not planned), and deleting the GitHub secret stops
this workflow using the token while, in Anthropic's own words, "the credential it held stays
valid". Community reports name `claude.ai/settings/claude-code` as a page that lists and
revokes these tokens; no Anthropic document confirms it. Whether removing the minting person
from the organisation invalidates their token is likewise unestablished — one report describes a
token still working after deletion from the web interface. Under compromise, the token's own
expiry is the only certain end, and the exposure until then is the subscription's quota.

Anthropic documents two ways to run an agent in CI without tying it to one person's
subscription; this workflow uses neither. A Console API key (`ANTHROPIC_API_KEY`, minted at
platform.claude.com) is what the docs recommend for any secret shared across repositories,
precisely because it is not tied to a subscription; it bills per token. Workload Identity
Federation has the Claude Code GitHub Action exchange the workflow's OpenID Connect token for
access through a Console service account, storing no long-lived secret; it is documented for
the Action, where the grooming job runs the CLI directly.
