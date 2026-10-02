import type { Credential } from './env-types.ts';

/**
 * GitHub secrets that workflows reference and the env registry does not hold:
 * deploy tooling, mobile signing, the mirror bot, the cassette bucket, and the
 * scheduled agents. Keyed by the `secrets.NAME` a workflow reads.
 */
export const CI_SECRETS: Record<string, Credential> = {
  CLOUDFLARE_API_TOKEN: {
    description:
      'Deploys the Worker and the frontend, uploads to R2 and writes every Worker secret; its Cloudflare-side scope is whatever the account grants it.',
    store: 'github:production',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'cloudflare-api-token',
    userVisible: 'none',
    leakImpact: 'companyEnding',
  },
  GITLEAKS_LICENSE: {
    description: 'Runs the licensed gitleaks organisation scanner in CI.',
    store: 'github:ci',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'gitleaks-license',
    userVisible: 'none',
    leakImpact: 'nuisance',
  },
  HUSHBOX_SYNC_PRIVATE_KEY: {
    description:
      'Authenticates as the sync GitHub App, the sole writer of the public main branch, whose push is the production deploy trigger.',
    store: 'github:repository',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'github-app-key',
    userVisible: 'none',
    leakImpact: 'companyEnding',
  },
  // The escrow upload's transport: where the bucket is, and the pair that signs
  // for it. All four are held at repository level rather than in one GitHub
  // environment: a job runs under each environment that holds an escrowed
  // secret, all of them write to the same bucket, and an environment secret is
  // unreadable from any other environment. Repository level gives up whatever
  // protection rules an environment carries, and what bounds that is the
  // credentials themselves — they write escrow objects and list bucket names,
  // read nothing back, and every object uploaded is already encrypted to
  // recipients whose identities live outside this system. The two addresses are
  // held as secrets rather than written here so that no file in this repository
  // names where the offline copies are kept.
  ESCROW_B2_BUCKET: {
    description:
      'Names the Backblaze B2 bucket the escrow copies are written to; an address, not a grant. Held at repository level so the escrow job of every environment can read it, and out of the repository so no file here says where the copies are kept.',
    store: 'github:repository',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'backblaze-key',
    userVisible: 'none',
    coupledWith: ['ESCROW_B2_S3_ENDPOINT', 'ESCROW_B2_KEY_ID', 'ESCROW_B2_APPLICATION_KEY'],
    leakImpact: 'nuisance',
  },
  ESCROW_B2_S3_ENDPOINT: {
    description:
      'The region-scoped Backblaze B2 S3 API endpoint address the escrow upload signs against; an address, not a grant. Held at repository level so the escrow job of every environment can read it, and out of the repository so no file here says where the copies are kept.',
    store: 'github:repository',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'backblaze-key',
    userVisible: 'none',
    coupledWith: ['ESCROW_B2_BUCKET', 'ESCROW_B2_KEY_ID', 'ESCROW_B2_APPLICATION_KEY'],
    leakImpact: 'nuisance',
  },
  ESCROW_B2_KEY_ID: {
    description:
      'The Backblaze B2 application key id for the escrow bucket; pairs with the application key. Held at repository level so the escrow job of every environment can read it.',
    store: 'github:repository',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'backblaze-key',
    userVisible: 'none',
    coupledWith: ['ESCROW_B2_APPLICATION_KEY', 'ESCROW_B2_BUCKET', 'ESCROW_B2_S3_ENDPOINT'],
    leakImpact: 'nuisance',
  },
  ESCROW_B2_APPLICATION_KEY: {
    description:
      'Writes escrow objects and lists bucket names, and reads nothing: the objects it writes are encrypted to offline recipients before upload. Held at repository level so the escrow job of every environment can read it; the write-only capability set is what bounds that widening.',
    store: 'github:repository',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'backblaze-key',
    userVisible: 'none',
    coupledWith: ['ESCROW_B2_KEY_ID', 'ESCROW_B2_BUCKET', 'ESCROW_B2_S3_ENDPOINT'],
    leakImpact: 'nuisance',
  },
  ANDROID_KEYSTORE_BASE64: {
    description:
      'The Android upload keystore; with Play App Signing enrolled it is a resettable upload key, not the app identity.',
    store: 'github:production',
    replace: 'adminAction',
    onLoss: 'restoreFromCopy',
    family: 'android-signing',
    userVisible: 'none',
    coupledWith: ['ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_PASSWORD'],
    leakImpact: 'expensive',
  },
  ANDROID_KEYSTORE_PASSWORD: {
    description: 'Decrypts the Android upload keystore file.',
    store: 'github:production',
    replace: 'adminAction',
    onLoss: 'restoreFromCopy',
    family: 'android-signing',
    userVisible: 'none',
    coupledWith: ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEY_PASSWORD'],
    leakImpact: 'expensive',
  },
  ANDROID_KEY_PASSWORD: {
    description: 'Decrypts the signing key inside the Android upload keystore.',
    store: 'github:production',
    replace: 'adminAction',
    onLoss: 'restoreFromCopy',
    family: 'android-signing',
    userVisible: 'none',
    coupledWith: ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD'],
    leakImpact: 'expensive',
  },
  PLAY_STORE_JSON_KEY: {
    description: 'Google service-account key authorised to upload builds to the Play Console.',
    store: 'github:production',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'google-service-account',
    userVisible: 'none',
    leakImpact: 'severe',
  },
  ASC_KEY_CONTENT: {
    description:
      'The App Store Connect API private key: uploads builds and manages certificates and provisioning profiles.',
    store: 'github:production',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'ios-signing',
    userVisible: 'none',
    leakImpact: 'severe',
  },
  MATCH_PASSWORD: {
    description: 'Decrypts the certificate and profile store fastlane match maintains.',
    store: 'github:production',
    replace: 'adminAction',
    onLoss: 'restoreFromCopy',
    family: 'ios-signing',
    userVisible: 'none',
    leakImpact: 'severe',
  },
  MATCH_GIT_BASIC_AUTHORIZATION: {
    description:
      'Git credential for the private repository holding the encrypted iOS certificates and profiles.',
    store: 'github:production',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'ios-signing',
    userVisible: 'none',
    leakImpact: 'severe',
  },
  CASSETTE_R2_ACCESS_KEY_ID: {
    description:
      'Access key id for the AI-cassette R2 bucket CI replays from; pairs with the secret key.',
    store: 'github:ci',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'r2-token',
    userVisible: 'none',
    coupledWith: ['CASSETTE_R2_SECRET_ACCESS_KEY'],
    leakImpact: 'nuisance',
  },
  CASSETTE_R2_SECRET_ACCESS_KEY: {
    description: 'Reads and writes the recorded AI-call cassette store CI replays from.',
    store: 'github:ci',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'r2-token',
    userVisible: 'none',
    coupledWith: ['CASSETTE_R2_ACCESS_KEY_ID'],
    leakImpact: 'expensive',
  },
  HOOKDECK_API_KEY: {
    description:
      'Authenticates the Hookdeck CLI for the webhook CI lane; carries no production credential.',
    store: 'github:ci',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'hookdeck-key',
    userVisible: 'none',
    leakImpact: 'nuisance',
  },
  LINEAR_API_KEY_WRITE: {
    description: 'Reads and writes the Linear workspace for the board-grooming workflow.',
    store: 'github:linear',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'linear-key',
    userVisible: 'none',
    leakImpact: 'expensive',
  },
  CLAUDE_CODE_OAUTH_TOKEN: {
    description:
      'Runs the Claude Code agent for the board-grooming workflow against the account quota.',
    store: 'github:linear',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'claude-code-token',
    userVisible: 'none',
    leakImpact: 'expensive',
  },
  STRYKER_DASHBOARD_API_KEY: {
    description: 'Publishes mutation-testing results to the Stryker dashboard.',
    store: 'github:ci',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'stryker-key',
    userVisible: 'none',
    leakImpact: 'nuisance',
  },
};

/**
 * Workflow `secrets.NAME` values that are identifiers, not credentials: an id,
 * a bucket name, an alias, a fingerprint, or the per-run token GitHub mints.
 * Held as secrets for convenience; holding one grants nothing.
 */
export const CI_IDENTIFIERS: readonly string[] = [
  'GITHUB_TOKEN',
  'HUSHBOX_SYNC_APP_ID',
  'ANDROID_KEY_ALIAS',
  'ASC_KEY_ID',
  'ASC_ISSUER_ID',
  'MATCH_GIT_URL',
  'APPLE_TEAM_ID',
  'ANDROID_CERT_SHA256_FINGERPRINT',
  'CASSETTE_R2_ACCOUNT_ID',
  'CASSETTE_R2_BUCKET',
];
