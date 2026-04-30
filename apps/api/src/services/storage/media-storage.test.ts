import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageReadError, StorageWriteError } from './types.js';

const fetchMock = vi.fn();
const signMock = vi.fn();
const awsClientConstructor = vi.fn();

vi.mock('aws4fetch', () => ({
  AwsClient: class MockAwsClient {
    constructor(options: unknown) {
      awsClientConstructor(options);
    }
    fetch = fetchMock;
    sign = signMock;
  },
}));

const { createMediaStorage } = await import('./media-storage.js');

function baseEnv(overrides: Record<string, string | undefined> = {}): {
  R2_S3_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_MEDIA?: string;
} {
  return {
    R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'test-access-id',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_MEDIA: 'hushbox-media',
    ...overrides,
  };
}

function okResponse(body = ''): Response {
  return new Response(body, { status: 200 });
}

function errorResponse(status: number, body = 'error'): Response {
  return new Response(body, { status });
}

describe('createMediaStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fail-fast config validation', () => {
    it.each([
      ['R2_S3_ENDPOINT', 'R2_S3_ENDPOINT'],
      ['R2_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID'],
      ['R2_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY'],
      ['R2_BUCKET_MEDIA', 'R2_BUCKET_MEDIA'],
    ])('throws when %s is missing', (envKey, expected) => {
      const env = baseEnv({ [envKey]: undefined });
      expect(() => createMediaStorage(env)).toThrow(new RegExp(expected));
    });

    it('throws when an env var is empty string', () => {
      const env = baseEnv({ R2_ACCESS_KEY_ID: '' });
      expect(() => createMediaStorage(env)).toThrow(/R2_ACCESS_KEY_ID/);
    });

    it('constructs an AwsClient with the provided credentials', () => {
      createMediaStorage(baseEnv());
      expect(awsClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          accessKeyId: 'test-access-id',
          secretAccessKey: 'test-secret',
          service: 's3',
          region: 'auto',
        })
      );
    });
  });

  describe('put', () => {
    it('PUTs to {endpoint}/{bucket}/{key} with bytes and Content-Type', async () => {
      fetchMock.mockResolvedValueOnce(okResponse());
      const storage = createMediaStorage(baseEnv());
      const bytes = new Uint8Array([1, 2, 3]);

      await storage.put('media/c/m/i.enc', bytes, 'application/octet-stream');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toContain(
        'https://abc.r2.cloudflarestorage.com/hushbox-media/media%2Fc%2Fm%2Fi.enc'
      );
      const initObject = init as {
        method?: string;
        body?: ArrayBuffer;
        headers?: Record<string, string>;
      };
      expect(initObject.method).toBe('PUT');
      expect(initObject.body).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(initObject.body!)]).toEqual([...bytes]);
      expect(initObject.headers?.['Content-Type']).toBe('application/octet-stream');
    });

    it('throws StorageWriteError when the response is non-OK', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500, 'oops'));
      const storage = createMediaStorage(baseEnv());

      await expect(
        storage.put('k', new Uint8Array([1]), 'application/octet-stream')
      ).rejects.toBeInstanceOf(StorageWriteError);
    });

    it('throws StorageWriteError when fetch rejects', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network'));
      const storage = createMediaStorage(baseEnv());

      await expect(
        storage.put('k', new Uint8Array([1]), 'application/octet-stream')
      ).rejects.toBeInstanceOf(StorageWriteError);
    });
  });

  describe('delete', () => {
    it('DELETEs to {endpoint}/{bucket}/{key}', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const storage = createMediaStorage(baseEnv());

      await storage.delete('media/c/m/i.enc');

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toContain(
        'https://abc.r2.cloudflarestorage.com/hushbox-media/media%2Fc%2Fm%2Fi.enc'
      );
      expect((init as { method: string }).method).toBe('DELETE');
    });

    it('treats 404 as success (idempotent)', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(404));
      const storage = createMediaStorage(baseEnv());

      await expect(storage.delete('missing-key')).resolves.toBeUndefined();
    });

    it('throws StorageWriteError on 500', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500));
      const storage = createMediaStorage(baseEnv());

      await expect(storage.delete('k')).rejects.toBeInstanceOf(StorageWriteError);
    });
  });

  describe('mintDownloadUrl', () => {
    it('signs a GET to {endpoint}/{bucket}/{key} with signQuery=true', async () => {
      const signedUrl = 'https://abc.r2.cloudflarestorage.com/hushbox-media/k?X-Amz-Signature=xyz';
      signMock.mockResolvedValueOnce(new Request(signedUrl));
      const storage = createMediaStorage(baseEnv());

      const { url } = await storage.mintDownloadUrl({ key: 'media/c/m/i.enc' });

      expect(signMock).toHaveBeenCalledTimes(1);
      const [inputUrl, init] = signMock.mock.calls[0] ?? [];
      expect(inputUrl as string).toContain(
        'https://abc.r2.cloudflarestorage.com/hushbox-media/media%2Fc%2Fm%2Fi.enc'
      );
      expect((inputUrl as string).includes('X-Amz-Expires=')).toBe(true);
      expect((init as { method: string }).method).toBe('GET');
      expect((init as { aws: { signQuery: boolean } }).aws.signQuery).toBe(true);
      expect(url).toBe(signedUrl);
    });

    it('uses the default TTL when expiresInSec is omitted', async () => {
      signMock.mockResolvedValueOnce(new Request('https://s/x'));
      const storage = createMediaStorage(baseEnv());

      await storage.mintDownloadUrl({ key: 'k' });
      const inputUrl = signMock.mock.calls[0]?.[0] as string;
      expect(inputUrl).toContain('X-Amz-Expires=300');
    });

    it('honors expiresInSec when provided', async () => {
      signMock.mockResolvedValueOnce(new Request('https://s/x'));
      const storage = createMediaStorage(baseEnv());

      await storage.mintDownloadUrl({ key: 'k', expiresInSec: 60 });
      const inputUrl = signMock.mock.calls[0]?.[0] as string;
      expect(inputUrl).toContain('X-Amz-Expires=60');
    });

    it('returns an ISO-8601 expiresAt timestamp roughly TTL from now', async () => {
      signMock.mockResolvedValueOnce(new Request('https://s/x'));
      const storage = createMediaStorage(baseEnv());

      const before = Date.now();
      const { expiresAt } = await storage.mintDownloadUrl({ key: 'k', expiresInSec: 60 });
      const after = Date.now();
      const expiryMs = new Date(expiresAt).getTime();

      expect(expiryMs).toBeGreaterThanOrEqual(before + 60_000);
      expect(expiryMs).toBeLessThanOrEqual(after + 60_000 + 1000);
    });

    it('throws StorageReadError when signing fails', async () => {
      signMock.mockRejectedValueOnce(new Error('signing failed'));
      const storage = createMediaStorage(baseEnv());

      await expect(storage.mintDownloadUrl({ key: 'k' })).rejects.toBeInstanceOf(StorageReadError);
    });
  });

  describe('list', () => {
    function buildListResponse(
      objects: { key: string; lastModified: string; size: number }[],
      truncated: { nextContinuationToken: string } | null = null
    ): string {
      const contents = objects
        .map(
          (o) =>
            `<Contents><Key>${o.key}</Key><LastModified>${o.lastModified}</LastModified><Size>${String(o.size)}</Size></Contents>`
        )
        .join('');
      const truncatedTag = truncated === null ? '<IsTruncated>false</IsTruncated>' : '';
      const cursorTag =
        truncated === null
          ? ''
          : `<IsTruncated>true</IsTruncated><NextContinuationToken>${truncated.nextContinuationToken}</NextContinuationToken>`;
      return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}${truncatedTag}${cursorTag}</ListBucketResult>`;
    }

    it('returns parsed objects from a non-truncated response', async () => {
      const xml = buildListResponse([
        { key: 'media/a.enc', lastModified: '2026-01-15T12:00:00.000Z', size: 1024 },
        { key: 'media/b.enc', lastModified: '2026-01-16T12:00:00.000Z', size: 2048 },
      ]);
      fetchMock.mockResolvedValueOnce(okResponse(xml));
      const storage = createMediaStorage(baseEnv());

      const result = await storage.list('media/');

      expect(result.objects).toHaveLength(2);
      expect(result.objects[0]).toEqual({
        key: 'media/a.enc',
        uploaded: new Date('2026-01-15T12:00:00.000Z'),
        size: 1024,
      });
      expect(result.nextCursor).toBeUndefined();
    });

    it('returns nextCursor for truncated responses', async () => {
      const xml = buildListResponse(
        [{ key: 'media/a.enc', lastModified: '2026-01-15T12:00:00.000Z', size: 1024 }],
        { nextContinuationToken: 'abc-cursor' }
      );
      fetchMock.mockResolvedValueOnce(okResponse(xml));
      const storage = createMediaStorage(baseEnv());

      const result = await storage.list('media/');

      expect(result.nextCursor).toBe('abc-cursor');
    });

    it('passes cursor and limit to S3', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(buildListResponse([])));
      const storage = createMediaStorage(baseEnv());

      await storage.list('media/', { cursor: 'my-cursor', limit: 500 });

      const url = fetchMock.mock.calls[0]?.[0] as string;
      expect(url).toContain('list-type=2');
      expect(url).toContain('prefix=media%2F');
      expect(url).toContain('max-keys=500');
      expect(url).toContain('continuation-token=my-cursor');
    });

    it('returns empty array for an empty bucket', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(buildListResponse([])));
      const storage = createMediaStorage(baseEnv());

      const result = await storage.list('media/');

      expect(result.objects).toHaveLength(0);
      expect(result.nextCursor).toBeUndefined();
    });

    it('throws StorageReadError on non-OK response', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500));
      const storage = createMediaStorage(baseEnv());

      await expect(storage.list('media/')).rejects.toBeInstanceOf(StorageReadError);
    });

    it('skips malformed Contents blocks (missing Size) without throwing', async () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
        '<Contents><Key>good.bin</Key><LastModified>2026-04-30T12:00:00.000Z</LastModified><Size>100</Size></Contents>' +
        '<Contents><Key>broken.bin</Key><LastModified>2026-04-30T12:00:00.000Z</LastModified></Contents>' +
        '<IsTruncated>false</IsTruncated></ListBucketResult>';
      fetchMock.mockResolvedValueOnce(okResponse(xml));
      const storage = createMediaStorage(baseEnv());

      const result = await storage.list('media/');

      expect(result.objects).toHaveLength(1);
      expect(result.objects[0]!.key).toBe('good.bin');
      expect(result.nextCursor).toBeUndefined();
    });
  });
});
