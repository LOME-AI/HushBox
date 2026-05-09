import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildCorsXml,
  configureR2Cors,
  parseCliArgs,
  PRODUCTION_ALLOWED_ORIGINS,
  type ConfigureR2CorsDeps,
} from './configure-cors';

describe('buildCorsXml', () => {
  it('emits a CORSConfiguration with one CORSRule per origin', () => {
    const xml = buildCorsXml({
      origins: ['https://hushbox.ai', 'https://*.hushbox.pages.dev'],
      methods: ['GET'],
      allowedHeaders: ['*'],
      maxAgeSeconds: 3600,
    });
    expect(xml).toContain('<CORSConfiguration>');
    expect(xml).toContain('<CORSRule>');
    expect(xml).toContain('<AllowedOrigin>https://hushbox.ai</AllowedOrigin>');
    expect(xml).toContain('<AllowedOrigin>https://*.hushbox.pages.dev</AllowedOrigin>');
    expect(xml).toContain('<AllowedMethod>GET</AllowedMethod>');
    expect(xml).toContain('<AllowedHeader>*</AllowedHeader>');
    expect(xml).toContain('<MaxAgeSeconds>3600</MaxAgeSeconds>');
    expect(xml).toContain('</CORSConfiguration>');
  });

  it('defaults to the production origin allowlist when invoked with PRODUCTION_ALLOWED_ORIGINS', () => {
    const xml = buildCorsXml({
      origins: PRODUCTION_ALLOWED_ORIGINS,
      methods: ['GET'],
      allowedHeaders: ['*'],
      maxAgeSeconds: 3600,
    });
    expect(xml).toContain('https://hushbox.ai');
    expect(xml).toContain('https://*.hushbox.pages.dev');
  });

  it('escapes XML entities in origins to prevent malformed XML', () => {
    const xml = buildCorsXml({
      origins: ['https://example.com/a&b'],
      methods: ['GET'],
      allowedHeaders: ['*'],
      maxAgeSeconds: 3600,
    });
    expect(xml).toContain('https://example.com/a&amp;b');
    expect(xml).not.toContain('a&b<');
  });
});

describe('configureR2Cors', () => {
  const baseEnv = {
    R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_MEDIA: 'hushbox-media',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PUTs the CORS XML to {endpoint}/{bucket}?cors with the AWS-signed client', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 200 }));
    const deps: ConfigureR2CorsDeps = {
      env: baseEnv,
      createClient: vi.fn().mockReturnValue({ fetch: fetchMock }),
    };

    await configureR2Cors(deps);

    expect(deps.createClient).toHaveBeenCalledWith({
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      service: 's3',
      region: 'auto',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://abc.r2.cloudflarestorage.com/hushbox-media?cors');
    expect((init as { method: string }).method).toBe('PUT');
    const body = (init as { body: string }).body;
    expect(body).toContain('https://hushbox.ai');
    expect(body).toContain('https://*.hushbox.pages.dev');
    expect(body).toContain('<AllowedMethod>GET</AllowedMethod>');
    expect(body).toContain('<MaxAgeSeconds>3600</MaxAgeSeconds>');
    expect(body).toContain('<AllowedHeader>*</AllowedHeader>');
  });

  it('throws when the CORS PUT returns a non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('access denied', { status: 403 }));
    const deps: ConfigureR2CorsDeps = {
      env: baseEnv,
      createClient: vi.fn().mockReturnValue({ fetch: fetchMock }),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/403/);
  });

  it('fails fast when R2_S3_ENDPOINT is missing', async () => {
    const deps: ConfigureR2CorsDeps = {
      env: { ...baseEnv, R2_S3_ENDPOINT: '' },
      createClient: vi.fn(),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/R2_S3_ENDPOINT/);
  });

  it('fails fast when R2_ACCESS_KEY_ID is missing', async () => {
    const deps: ConfigureR2CorsDeps = {
      env: { ...baseEnv, R2_ACCESS_KEY_ID: '' },
      createClient: vi.fn(),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/R2_ACCESS_KEY_ID/);
  });

  it('fails fast when R2_SECRET_ACCESS_KEY is missing', async () => {
    const deps: ConfigureR2CorsDeps = {
      env: { ...baseEnv, R2_SECRET_ACCESS_KEY: '' },
      createClient: vi.fn(),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/R2_SECRET_ACCESS_KEY/);
  });

  it('fails fast when R2_BUCKET_MEDIA is missing', async () => {
    const deps: ConfigureR2CorsDeps = {
      env: { ...baseEnv, R2_BUCKET_MEDIA: '' },
      createClient: vi.fn(),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/R2_BUCKET_MEDIA/);
  });
});

describe('parseCliArgs', () => {
  it('returns default origins when no override is provided', () => {
    const result = parseCliArgs([]);
    expect(result).toEqual({ origins: PRODUCTION_ALLOWED_ORIGINS });
  });

  it('parses --origins=a,b,c into an array', () => {
    const result = parseCliArgs(['--origins=https://a,https://b']);
    expect(result).toEqual({ origins: ['https://a', 'https://b'] });
  });

  it('returns an error when an origin is empty', () => {
    const result = parseCliArgs(['--origins=']);
    expect(result).toEqual({ error: expect.stringContaining('--origins=') });
  });
});
