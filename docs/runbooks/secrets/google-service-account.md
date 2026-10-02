# Google service-account keys

Obtain a JSON key for a service account holding the minimum role — the production FCM sender, the CI validate-only sender, and the Play Console upload account — plus the Firebase project ID that ships beside each FCM key and the Android app's `google-services.json`, which is a client configuration rather than a key. A service account holds more than one key at a time, so the successor is created and proven before the old key is disabled and deleted. Design: `docs/SECRETS.md`.

## Three consoles

Every step below names its console, because three overlap on one Google project:

- **Firebase console** — the project ID, the Android app registration, `google-services.json`, and SHA fingerprints. Its "Project settings" -> "Service accounts" tab carries a "Generate New Private Key" button; that button mints a key only for the project's pre-existing default Admin SDK account (`firebase-adminsdk-<suffix>@<project-id>.iam.gserviceaccount.com`), whose role is broader than sending needs and is not stated on Google's page. No key in this runbook comes from that button.
- **Google Cloud console** — service accounts, their roles, and their keys, in the same project.
- **Play Console** — the upload grant, made after the account exists in Google Cloud.

## Obtain

### `FCM_PROJECT_ID` and `FCM_PROJECT_ID_CI`

Firebase console -> gear icon -> "Project settings" -> "General" tab -> "Your project" card -> "Project ID". The value is fixed at project creation. It is the same identifier the Google Cloud console shows for the project; research established that from search results, not from a Google page.

Set `FCM_PROJECT_ID` in the `production` environment beside `FCM_SERVICE_ACCOUNT_JSON`, and `FCM_PROJECT_ID_CI` in the `ci` environment beside `FCM_SERVICE_ACCOUNT_JSON_CI`; each pair is coupled and ships together. `FCM_PROJECT_ID_CI` names whichever project the CI service account lives in — whether that is the production project or a separate one is recorded nowhere in the repository.

### `FCM_SERVICE_ACCOUNT_JSON` — the production sender

Google Cloud console, the FCM project:

1. "IAM & Admin" -> "Service Accounts" -> "+ Create Service Account" -> name it -> "Create". Google's page for this trail was fetched incompletely during research; the labels are as its overview pages give them.
2. "IAM & Admin" -> "IAM" -> "Grant Access" -> the account's email -> role "Firebase Cloud Messaging API Admin" (`roles/firebasecloudmessaging.admin`) -> "Save". It is the only predefined role carrying `cloudmessaging.messages.create`, the permission a send needs; "Firebase Cloud Messaging API Viewer" (`roles/firebasecloudmessaging.viewer`) cannot send. "Firebase Admin" (`roles/firebase.admin`) also sends but grants the whole Firebase project and is avoidable; its breadth was established from search results, not from the roles reference the FCM roles were read from.
3. "Service Accounts" -> the account -> "Keys" tab -> "Add key" -> "Create new key" -> "JSON" -> "Create". The browser downloads a JSON file. That download is the private key's only display: the console never shows it again, and a lost file means a new key.

The secret value is the file's whole text. The adapter (`apps/api/src/slices/notifications/adapters/push-fcm.ts`) reads `client_email` and `private_key` from it and rejects a value lacking either — at the first send, never at deploy.

Write the offline copy (the file itself). Set `FCM_SERVICE_ACCOUNT_JSON` in the `production` environment together with `FCM_PROJECT_ID`.

Probe: a push to a native device you hold, after the deploy. The adapter parses the key and exchanges it for an OAuth token at that first send, so a wrong file or a missing role surfaces as that push failing. The repository's only validate-only exercise of an FCM key is the CI live test named under the CI key, and it refuses to run outside CI; no shell probe for this key was established during research.

### `FCM_SERVICE_ACCOUNT_JSON_CI` — the CI validate-only sender

A separate service account, never the production one. The registry (`packages/shared/src/env/env.config.ts`) and `docs/NOTIFICATIONS.md` declare its role as a custom IAM role holding `cloudmessaging.messages.create` alone: Google Cloud console -> "IAM & Admin" -> "Roles" -> "Create role" -> add that one permission. Google's own page for building a custom role was not read during research, and only third-party guides describe one holding this permission alone, so follow the labels the console shows. Grant the role and create the key exactly as for the production sender.

What that role does and does not do: `validate_only` is a field in the request body of the same `projects.messages.send` call, under the same permission, and no IAM role distinguishes validating from delivering. This key can deliver a message to a device. It reaches none because the CI test sends `validate_only: true` to a fabricated token and nothing else — a property of what CI sends, never of what the key may do.

Write the offline copy. Set `FCM_SERVICE_ACCOUNT_JSON_CI` in the `ci` environment together with `FCM_PROJECT_ID_CI`.

Probe: the CI vitest job. `apps/api/src/slices/notifications/adapters/push-fcm-live.integration.test.ts` sends one validate-only message with the key, and `pnpm verify:evidence --require=push-fcm` fails the job unless Google accepted the call; a rejected key fails CI on the next push to any branch.

### `GOOGLE_SERVICES_JSON_BASE64` — the Android app configuration

Not a key: the file holds the project's identifiers and a client API key that Google does not treat as secret. Firebase console -> "Project Overview" -> the Android icon (or "Add app") -> "Android package name": the `applicationId` in `apps/web/android/app/build.gradle`, case-sensitive and immutable for the Firebase app once registered -> optional "App nickname" -> "Register app" -> "Download google-services.json". Once the app is registered, the file downloads again any time from "Project settings" -> "Your apps". A signing-key change adds a fingerprint under the same app ("SHA certificate fingerprints" -> "Add fingerprint") and then re-downloads the file; `docs/runbooks/secrets/android-signing.md` says when.

Check the file's name before encoding — a browser that already holds one saves the next as `google-services (2).json`, and the encode step names the file:

```
base64 < google-services.json
```

Write the offline copy (the file). Set the output as `GOOGLE_SERVICES_JSON_BASE64` in the `production` environment.

Probe: the next Android build. `.github/workflows/build-android.yml` decodes the value into `apps/web/android/app/google-services.json` before Gradle runs, and the Gradle google-services plugin applies only when that file exists; a value that is not valid base64 fails the decode step, and a push arriving on that build proves the file matches the project.

### `PLAY_STORE_JSON_KEY` — the Play upload account

Google Cloud first, then the Play Console. Google's setup page states that linking the developer account to a Google Cloud project is not required (its banner is dated 2025-12-18); any project serves, and the FCM project is the one already at hand.

Google Cloud console:

1. "APIs & Services" -> "Library" -> "Google Play Android Developer API" (`androidpublisher.googleapis.com`) -> "Enable".
2. "IAM & Admin" -> "Service Accounts" -> "+ Create Service Account" -> name it -> "Create". It needs no Google Cloud role: Google's setup page has no role step, and the Play Console grant is the whole authorization.
3. "Keys" tab -> "Add key" -> "Create new key" -> "JSON" -> "Create" — shown once, as above.

Play Console, signed in as a user holding "Admin (all permissions)":

1. "Users and permissions" -> "Invite new users" -> email: the `client_email` from the JSON file, exactly.
2. "App permissions" tab -> "Add app" -> select the app -> "Apply".
3. Turn on "Release apps to testing tracks" and "Release to production, exclude devices, and use Play App Signing" -> "Invite user". The first alone creates releases on the `internal` track, which the Release workflow uploads to for every track but `production`; the second is needed because the workflow's `production` track uploads to the Play production track (`.github/workflows/release.yml`).

Google's setup page also names an "API access" page; community reports show it absent for some accounts, and the trail above does not depend on it. Google states no propagation delay for the grant, and none is stated here.

The secret value is the file's whole text; Fastlane's `upload_aab` lane (`apps/web/android/fastlane/Fastfile`) passes it as `json_key_data`. Write the offline copy. Set `PLAY_STORE_JSON_KEY` in the `production` environment.

Probe: the Release workflow with platform `play_store` and track `internal`, which uploads the bundle to the Play internal track with this key. The app must already exist in the Play Console — a service account cannot create it, so a new app's first upload is manual (inferred during research from Google's API reference, not read from a page saying so).

## Replace

For each key: create the successor on the same account (or on a successor account carrying the same grant), set it, run the probe, then in the account's "Keys" tab disable the old key, run the probe again, and delete it — deletion is irreversible. `google-services.json` is replaced by re-downloading it, never by minting anything.
