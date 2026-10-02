/**
 * An installation access token for the sync bot's GitHub App.
 *
 * The bot is the only writer of public `main` and the only reader of the
 * private staging repository from CI, so every automation that crosses between
 * the two repositories mints its credential here. One implementation rather
 * than one per workflow: the signing shape, the backdating and the refusals are
 * where two copies would quietly disagree.
 *
 * The app's own JWT is short-lived and signed locally; it buys nothing but the
 * right to ask for the installation token, which is what the API calls take.
 */
import { createSign } from 'node:crypto';

export interface AppCredentials {
  readonly appId: string;
  /** The app's PEM private key, as the founder stored it. */
  readonly privateKey: string;
}

/**
 * The API rejects an app JWT valid for more than ten minutes. This sits well
 * inside that so a slow request cannot expire mid-flight.
 */
export const JWT_LIFETIME_SECONDS = 540;

const API = 'https://api.github.com';

const segment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/**
 * `issuedAtSeconds` is a parameter rather than a clock read so the signing
 * shape is testable; the CLI passes the real clock.
 */
export function buildAppJwt(credentials: AppCredentials, issuedAtSeconds: number): string {
  const header = segment({ alg: 'RS256', typ: 'JWT' });
  // Backdated by a second: GitHub rejects a JWT issued in its own future, and
  // the signer's clock is not GitHub's.
  const payload = segment({
    iat: issuedAtSeconds - 1,
    exp: issuedAtSeconds + JWT_LIFETIME_SECONDS,
    iss: credentials.appId,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(credentials.privateKey, 'base64url')}`;
}

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'hushbox-sync',
});

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    // The body is withheld: an error body from an authentication endpoint can
    // quote back what was sent to it.
    throw new Error(`${what} failed with status ${String(response.status)}.`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * What a minted token may reach, narrower than the app's grant. The mint can
 * only narrow: a permission the app does not hold is refused, never granted.
 */
interface TokenScope {
  /** Repository names without the owner, as the mint reads them. */
  readonly repositories: readonly string[];
  readonly permissions: Readonly<Record<string, 'read' | 'write'>>;
}

/** Where the installation is looked up, and what the token minted from it may reach. */
export interface ScopedInstallation {
  /** The `owner/name` whose installation mints the token. */
  readonly repository: string;
  readonly scope: TokenScope;
}

interface MintRequest {
  readonly credentials: AppCredentials;
  readonly repository: string;
  readonly issuedAtSeconds: number;
  readonly fetchImpl: typeof fetch;
  /** Absent, the mint is sent no body and the token carries the app's whole grant. */
  readonly scope?: TokenScope;
}

async function mint(request: MintRequest): Promise<string> {
  const { credentials, repository, issuedAtSeconds, fetchImpl, scope } = request;
  const jwt = buildAppJwt(credentials, issuedAtSeconds);
  const found = await readJson(
    await fetchImpl(`${API}/repos/${repository}/installation`, {
      method: 'GET',
      headers: headers(jwt),
    }),
    'the installation lookup'
  );
  const installationId = found['id'];
  if (typeof installationId !== 'number') {
    throw new TypeError(`The app reports no installation on ${repository}.`);
  }
  const minted = await readJson(
    await fetchImpl(`${API}/app/installations/${String(installationId)}/access_tokens`, {
      method: 'POST',
      ...(scope === undefined
        ? { headers: headers(jwt) }
        : {
            headers: { ...headers(jwt), 'content-type': 'application/json' },
            body: JSON.stringify({
              repositories: scope.repositories,
              permissions: scope.permissions,
            }),
          }),
    }),
    'the token mint'
  );
  const token = minted['token'];
  if (typeof token !== 'string' || token === '') {
    throw new Error('The mint answered with no installation token.');
  }
  return token;
}

/** A token carrying every permission the app was granted. */
export async function installationAccessToken(
  credentials: AppCredentials,
  repository: string,
  issuedAtSeconds: number,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  return mint({ credentials, repository, issuedAtSeconds, fetchImpl });
}

/** A token narrowed to `installation.scope`, sent as the mint body. */
export async function scopedInstallationAccessToken(
  credentials: AppCredentials,
  installation: ScopedInstallation,
  issuedAtSeconds: number,
  fetchImpl: typeof fetch
): Promise<string> {
  return mint({
    credentials,
    repository: installation.repository,
    issuedAtSeconds,
    fetchImpl,
    scope: installation.scope,
  });
}
