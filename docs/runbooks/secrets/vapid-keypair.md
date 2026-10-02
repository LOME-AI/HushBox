# VAPID keypair

Obtain the browser-push keypair and swap it: `VAPID_PRIVATE_KEY` and `VAPID_PUBLIC_KEY` on the Worker and `VITE_VAPID_PUBLIC_KEY` in the frontend build, in one deploy. Every existing browser subscription becomes undeliverable at the swap; each browser re-subscribes on its next load, and pushes between the swap and that load are lost. Design: `docs/SECRETS.md`.

## Obtain

A P-256 keypair in the classic web-push wire form, both halves unpadded base64url: the public
key is the 65-byte uncompressed point (a leading `0x04` byte, then x, then y — 87 characters)
and the private key is the 32-byte scalar (43 characters, the JWK `d` value). No script in the
repository mints one; this command does, printing both:

```sh
node -e "const { generateKeyPairSync } = require('node:crypto'); const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const j = privateKey.export({ format: 'jwk' }); const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url'); console.log('VAPID_PUBLIC_KEY=' + pub); console.log('VAPID_PRIVATE_KEY=' + j.d);"
```

Nothing in the repository validates the shape: the registry checks presence only, and the
Worker's signer (`importSigningKey` in
`apps/api/src/slices/notifications/adapters/webpush/vapid.ts`) slices the public point at
fixed offsets and hands the parts to WebCrypto, so a malformed key surfaces as a WebCrypto
import failure on the first send, and a malformed public key as a `PushManager.subscribe`
failure in the browser. The sender's subject (`VAPID_SUBJECT`) is a registry literal, not a
secret.

Write the offline copy of the private key first (`docs/SECRETS.md` §Rules). Set the three
names so that one deploy carries them all: `VAPID_PRIVATE_KEY` and `VAPID_PUBLIC_KEY` in
the `production` GitHub environment, and `VITE_VAPID_PUBLIC_KEY` — the same public value —
once, at repository scope, which every job that compiles it reads whatever environment it
declares (the mobile build workflows under `production`, the web `build` job in
`.github/workflows/ci.yml` under `ci`). The repository copy is the only copy: delete any
environment-scoped copy of `VITE_VAPID_PUBLIC_KEY`, or the two drift by hand. A rotation
therefore touches two scopes — the pair in the environment, the public key at repository
level. The deploy publishes the Worker pair, and the public key reaches browsers in the web
bundle of the same deploy. All three names are escrowed, and that deploy's run captures them
before it publishes anything (`docs/runbooks/secrets/backblaze-key.md`).

**Functional probe.** In a browser profile with no prior subscription, switch push on in
settings and receive one push; its subscription was made with the new public key and signed
with the new private key, so one delivery proves the pair agrees.
