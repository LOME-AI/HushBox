import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  buildAppJwt,
  installationAccessToken,
  JWT_LIFETIME_SECONDS,
  scopedInstallationAccessToken,
  type AppCredentials,
} from './github-app-token.js';

const ISSUED_AT = TEST_DAY_START / SECOND_MS;

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CREDENTIALS: AppCredentials = { appId: '1234', privateKey };

const decodeSegment = (segment: string): unknown =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

describe('buildAppJwt', () => {
  it('signs with RS256, which is the only algorithm the app API accepts', () => {
    const [header = ''] = buildAppJwt(CREDENTIALS, ISSUED_AT).split('.');

    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('issues as the app and expires within the API ceiling', () => {
    const [, payload = ''] = buildAppJwt(CREDENTIALS, ISSUED_AT).split('.');

    expect(decodeSegment(payload)).toEqual({
      iss: CREDENTIALS.appId,
      // Backdated by a second: the API rejects a token issued in its future,
      // and the two clocks are not the same clock.
      iat: ISSUED_AT - 1,
      exp: ISSUED_AT + JWT_LIFETIME_SECONDS,
    });
  });

  it('carries a signature over the signing input', () => {
    const signature = buildAppJwt(CREDENTIALS, ISSUED_AT).split('.').at(2) ?? '';

    expect(signature.length).toBeGreaterThan(0);
  });

  it('stays inside the ten-minute ceiling the app API enforces', () => {
    expect(JWT_LIFETIME_SECONDS).toBeLessThanOrEqual(600);
  });
});

interface StubbedResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

function stubFetch(...responses: readonly StubbedResponse[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(() => {
    const next = queue.shift();
    if (next === undefined) throw new Error('the token exchange made an unexpected request');
    return Promise.resolve({
      ok: next.ok,
      status: next.status,
      json: (): Promise<unknown> => Promise.resolve(next.body),
    } as Response);
  }) as unknown as typeof fetch;
}

const INSTALLATION = { ok: true, status: 200, body: { id: 42 } };
const TOKEN = { ok: true, status: 201, body: { token: 'ghs-installation' } };

describe('installationAccessToken', () => {
  it('exchanges the app JWT for the installation token on the named repository', async () => {
    const fetchImpl = stubFetch(INSTALLATION, TOKEN);

    await expect(
      installationAccessToken(CREDENTIALS, 'owner/repo', ISSUED_AT, fetchImpl)
    ).resolves.toBe('ghs-installation');
  });

  it('asks the repository which installation serves it', async () => {
    const fetchImpl = stubFetch(INSTALLATION, TOKEN);

    await installationAccessToken(CREDENTIALS, 'owner/repo', ISSUED_AT, fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/owner/repo/installation',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('mints against the installation the repository named', async () => {
    const fetchImpl = stubFetch(INSTALLATION, TOKEN);

    await installationAccessToken(CREDENTIALS, 'owner/repo', ISSUED_AT, fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/app/installations/42/access_tokens',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('refuses when the app is not installed on the repository', async () => {
    const fetchImpl = stubFetch({ ok: false, status: 404, body: {} });

    await expect(
      installationAccessToken(CREDENTIALS, 'owner/repo', ISSUED_AT, fetchImpl)
    ).rejects.toThrow('404');
  });

  it('refuses when the mint is rejected', async () => {
    const fetchImpl = stubFetch(INSTALLATION, { ok: false, status: 401, body: {} });

    await expect(
      installationAccessToken(CREDENTIALS, 'owner/repo', ISSUED_AT, fetchImpl)
    ).rejects.toThrow('401');
  });

  it('refuses an answer that carries no token rather than passing an empty one on', async () => {
    const fetchImpl = stubFetch(INSTALLATION, { ok: true, status: 201, body: {} });

    await expect(
      installationAccessToken(CREDENTIALS, 'owner/repo', ISSUED_AT, fetchImpl)
    ).rejects.toThrow('no installation token');
  });

  it('refuses an installation answer that carries no id', async () => {
    const fetchImpl = stubFetch({ ok: true, status: 200, body: {} }, TOKEN);

    await expect(
      installationAccessToken(CREDENTIALS, 'owner/repo', ISSUED_AT, fetchImpl)
    ).rejects.toThrow('no installation');
  });
});

describe('a scoped installation token', () => {
  const SCOPE = { repositories: ['repo'], permissions: { actions: 'read' } } as const;

  it('asks the mint for exactly the named repositories and permissions', async () => {
    const fetchImpl = stubFetch(INSTALLATION, TOKEN);

    await scopedInstallationAccessToken(
      CREDENTIALS,
      { repository: 'owner/repo', scope: SCOPE },
      ISSUED_AT,
      fetchImpl
    );

    const [, init] = vi.mocked(fetchImpl).mock.calls[1] ?? [];
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      repositories: ['repo'],
      permissions: { actions: 'read' },
    });
  });

  it('looks the installation up through the named repository', async () => {
    const fetchImpl = stubFetch(INSTALLATION, TOKEN);

    await expect(
      scopedInstallationAccessToken(
        CREDENTIALS,
        { repository: 'owner/repo', scope: SCOPE },
        ISSUED_AT,
        fetchImpl
      )
    ).resolves.toBe('ghs-installation');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/owner/repo/installation',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('sends an unscoped mint with no body, so it carries the whole grant', async () => {
    const fetchImpl = stubFetch(INSTALLATION, TOKEN);

    await installationAccessToken(CREDENTIALS, 'owner/repo', ISSUED_AT, fetchImpl);

    const [, init] = vi.mocked(fetchImpl).mock.calls[1] ?? [];
    expect(init?.body).toBeUndefined();
  });
});
