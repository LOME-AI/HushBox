# Android signing and Play App Signing

The pre-launch signing posture and what to do when signing material is lost or leaked: generating the upload keystore and its passwords and writing their offline copy, confirming Play App Signing enrolment before the first release so the held keystore is a resettable upload key rather than the app's Play identity, resetting the upload key through the Play Console, and reading the certificate fingerprint Android App Links verifies against, which differs by install channel. Design: `docs/SECRETS.md`.

## Obtain

The three secrets and the alias are set together in the `production` GitHub environment:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, and the
identifier `ANDROID_KEY_ALIAS`. The build workflow decodes the keystore and checks the store
password against it before it builds anything, so a keystore set without its passwords, or a
wrong alias, fails every Android build at that step — set the four in one sitting.

### The upload keystore

Android's own signing documentation creates a keystore only through the Android Studio wizard
("Build" -> "Generate Signed Bundle / APK" -> "Create new" under the key store path) and prints
no `keytool -genkeypair` command; the command below is that wizard's operation, assembled from
Google's upload-key-reset support article, Oracle's `keytool` reference, and the constraints
Android's page states, all of which agree on it. With a JDK on the path:

```
keytool -genkeypair -v -keystore upload-keystore.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

- `-genkeypair` — generate a key pair and a self-signed certificate, creating the keystore file
  when it does not exist.
- `-v` — verbose output.
- `-keystore upload-keystore.jks` — the file to write; its base64 becomes
  `ANDROID_KEYSTORE_BASE64`.
- `-alias upload` — the entry's name inside the keystore, which is `ANDROID_KEY_ALIAS` and what
  every later `-list` and `-export` names.
- `-keyalg RSA -keysize 2048` — Android's stated floor for a self-managed upload key, "an RSA
  key of 2048 bits or more".
- `-validity 10000` — days. Google Play requires the certificate to stay valid past
  2033-10-22 and recommends at least 25 years; 10000 days is about 27.

`keytool` then prompts for the keystore password, which becomes `ANDROID_KEYSTORE_PASSWORD`,
the certificate's subject fields, and the key password, which becomes `ANDROID_KEY_PASSWORD`.
Whether the JDK's default keystore format keeps a key password distinct from the store password
was not established during research; the same value for both is correct under either answer,
and the build reads them as two secrets regardless. Choose the passwords and write their
offline copy before running the command, and add the keystore file to that copy once written:
the three restore together, and a fresh keystore is not a restoration but an upload-key reset
(§Replace).

### Encoding and setting

The secret holds the file's base64 on one line; CI decodes it with `base64 -d`:

```
base64 -w0 upload-keystore.jks > upload-keystore.jks.base64
```

(`base64 -i upload-keystore.jks -o upload-keystore.jks.base64` on macOS.) Set the file's text
as `ANDROID_KEYSTORE_BASE64`, the two passwords, and the alias.

### Play App Signing

With Play App Signing, Google holds the app signing key that signs what Play installs on
devices — the app's durable identity on that channel — and the keystore above is only the
upload key that proves to Google who uploaded a bundle: Google verifies that signature,
discards it, and re-signs with the key it holds. That split is what makes the upload key
replaceable (§Replace). A new app is enrolled automatically with a Google-generated key when it
is created and again when its first bundle is uploaded, and "the key you use to sign your first
release becomes your upload key"; an existing app signed with its own key is enrolled by
transferring that key through Google's PEPK tool, which this app never needs. An app that is
not enrolled has no upload-key reset. Before the first release, a Play Console user with Admin
permission confirms enrolment on the app's Play app signing screen — Google's own article
reaches it as "Protected with Play" -> "Play Store distribution" -> "Go to Play app signing" in
most sections and as "Protected with Play" -> "Play Store protection" -> "Manage Play app
signing" in one, both read from the same page; the Play Console has renamed this area more than
once, so follow the labels you see. The app signing key must be Google-managed, and the
"Upload key certificate" shown must carry the SHA-256 §Verify reads from the keystore.

Probe: dispatch the Release workflow with platform `play_store` and track `manual`. It decodes
the keystore, checks the store password, builds and signs the bundle, and attaches
`app-release.aab` as a workflow artifact without uploading; read its signer as §Verify says.
Track `internal` additionally uploads the bundle to the Play internal track with
`PLAY_STORE_JSON_KEY` (`docs/runbooks/secrets/google-service-account.md`), where Google checks it
against the upload key.

## Replace

The upload keystore is the operator-procedure class. Which channel an installed app came from
decides what replacing it costs:

- Play Store installs are signed by Google's app signing key, which never changes, so a
  replaced upload key affects nothing installed from Play.
- Direct-download installs — the APK the Release workflow attaches to a GitHub release for
  platform `github` — are signed by this keystore itself, and Android installs an update only
  when the same certificate signed it. On that channel the upload key is the app's identity:
  after a replacement those users must uninstall and reinstall, and the App Links fingerprint
  they verify against changes with it (§Verify).

A lost keystore, a lost password, or a leaked one: request an upload key reset. Generate a
replacement keystore and passwords exactly as in §Obtain, offline copy first, and export its
certificate — the public half only; the private key and the passwords never leave the machine:

```
keytool -export -rfc -keystore upload-keystore.jks -alias upload -file upload_certificate.pem
```

In the Play Console, with Admin permission, open the Play app signing screen (the trails in
§Obtain), and in the "Upload key certificate" section click "Request upload key reset", enter
the reason, attach `upload_certificate.pem`, and click "Request". Google states no turnaround
for a reset anywhere in its documentation, so no release can be planned against a window;
until Google confirms the reset, the old key is the one Play accepts. Once confirmed, set the
new keystore's base64, both passwords, and the alias together, run the probe, and dispatch the
escrow workflow (`.github/workflows/escrow-secrets.yml`, `workflow_dispatch`, `production`
environment; `docs/runbooks/secrets/backblaze-key.md`). The three secrets are escrowed, but the escrow
job runs on its own only in a deploy's run, and a signing change causes no deploy — without
the dispatch the escrow holds the old keystore for as long as nothing else lands on `main`.
Google's app signing key is not replaced for any of this and is held by no operator.

## Verify

Read the keystore's certificate fingerprints — the command prompts for the store password:

```
keytool -list -v -alias upload -keystore upload-keystore.jks
```

The "Certificate fingerprints" block prints SHA-1 and SHA-256. To confirm a built artifact
carries that certificate: for the APK,

```
apksigner verify --print-certs -v app-release.apk
```

(`apksigner` ships in the Android SDK build-tools) reports each signature scheme as verified
and the signer's SHA-256, which must equal the keystore's once case and colons are normalised;
for the bundle, `keytool -printcert -jarfile app-release.aab` displays the signer certificate
without checking content digests.

Which fingerprint an integration needs follows which key signs what the user installs. For Play
installs it is the app signing key's, copied from the Play app signing screen in the Play
Console and never from the local keystore — "the fingerprint of your upload key differs from
the Google-managed app signing key"; for direct-download installs it is this keystore's.
`ANDROID_CERT_SHA256_FINGERPRINT`, substituted into `assetlinks.json` before every deploy, is
one value, so App Links verify only for installs signed by the key it names. Firebase takes the
same fingerprint under the app's card in "Your apps" -> "Add fingerprint", after which
`google-services.json` is downloaded again (`docs/runbooks/secrets/google-service-account.md` for where
that file is set).
