# Self-minted random secrets

Obtain a secret that is random bytes minted by us with no vendor behind it: the session-cookie seal, the push collapse-alias key, the enumeration decoy secret, and the backup repository's encryption password. Replacement is minting again; the decoy secret is replaced rarely and with a reason. Design: `docs/SECRETS.md`.

## Obtain

One command mints any of the three — 32 random bytes as unpadded base64url, 43 characters:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Each is a string the code consumes as-is; what each one requires of the string:

- `IRON_SESSION_SECRET` — at least 32 characters. The registry enforces the floor at
  `pnpm verify:env`, and iron-session enforces it again at every seal and unseal, so a shorter
  value breaks every session request rather than the deploy.
- `ENUMERATION_DECOY_SECRET` — at least 32 characters (registry floor). It is HKDF input for
  the decoy server material that an unknown-identifier login opens, so that a wrong password
  and an unknown account take the same path.
- `NOTIFICATION_TAG_SECRET` — any non-empty string; the registry checks only presence. It is
  imported raw as the HMAC key that derives each conversation's push collapse alias, and the
  push-sender factory throws at construction when it is empty.
- `BACKUP_REPOSITORY_PASSWORD` — any non-empty string; the registry checks only presence. It
  encrypts the backup repository and is the only thing that decrypts it, so it is the one
  value here whose loss makes durable data unrecoverable. Set it in the `backup` environment,
  never `production`, and dispatch the escrow workflow choosing `backup` before the first
  backup run.

Write the offline copy first (`docs/SECRETS.md` §Rules), then set the value in the
`production` GitHub environment under its name; the deploy publishes it to the Worker after
the same run's escrow job has captured it. Every secret on this page is escrowed
(`docs/runbooks/secrets/backblaze-key.md`).

Nothing durable is sealed under the first three, so replacement is this section again with a
fresh value: the session seal signs everyone out once, the other two change nothing a user
sees. The repository password is the exception — replacing it adds a key to the repository
and sets the new value, and every backup already written stays readable
(`docs/BACKUPS.md`).

**Functional probes.** Session seal: a sign-in succeeds and the next request is still
authenticated. Decoy secret: a sign-in with an identifier that has no account fails exactly
like a wrong password, not with a server error. Tag secret: two pushes for one conversation
collapse into one pending notification (`docs/NOTIFICATIONS.md` §Dismissal).
Repository password: the next backup run reads the repository back rather than refusing it.
