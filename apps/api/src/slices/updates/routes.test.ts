import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { clearChecksumOverrides, setChecksumOverride } from '../../middleware/checksum-override.js';
import { pipelineEnv } from '../../middleware/pipeline-env.js';
import { clearVersionOverride, setVersionOverride } from '../../middleware/version-override.js';
import { createUpdatesManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';

const SERVER_VERSION = '3.1.4';

// Distinct per-platform checksums prove the route selects by platform, not a
// single shared value.
const IOS_CHECKSUM = 'a'.repeat(64);
const ANDROID_CHECKSUM = 'b'.repeat(64);
const ANDROID_DIRECT_CHECKSUM = 'c'.repeat(64);

// The dev harness's locally built bundle hashes to something no binding holds.
const OVERRIDE_CHECKSUM = 'd'.repeat(64);

interface TestBindings extends Bindings {
  APP_VERSION?: string;
  APP_BUNDLE_CHECKSUM_IOS?: string;
  APP_BUNDLE_CHECKSUM_ANDROID?: string;
  APP_BUNDLE_CHECKSUM_ANDROID_DIRECT?: string;
}

const baseEnv: TestBindings = {
  NODE_ENV: 'development',
  APP_VERSION: SERVER_VERSION,
  APP_BUNDLE_CHECKSUM_IOS: IOS_CHECKSUM,
  APP_BUNDLE_CHECKSUM_ANDROID: ANDROID_CHECKSUM,
  APP_BUNDLE_CHECKSUM_ANDROID_DIRECT: ANDROID_DIRECT_CHECKSUM,
};

const productionEnv: TestBindings = { ...baseEnv, NODE_ENV: 'production' };

function buildApp(): Hono<AppEnv> {
  const manifest = createUpdatesManifest();
  const app = new Hono<AppEnv>();
  // The real env stage, because the checksum gate branches on the mode it
  // derives; restating the derivation here would let the two disagree.
  app.use('*', pipelineEnv());
  return app
    .route(manifest.basePath, manifest.routes)
    .onError((_error, c) => c.json({ code: 'INTERNAL' }, 500));
}

async function get(
  path: string,
  env: TestBindings = baseEnv,
  headers: Record<string, string> = {}
): Promise<Response> {
  return buildApp().request(path, { headers }, env);
}

afterEach(() => {
  clearVersionOverride();
  clearChecksumOverrides();
});

describe('GET /updates/current', () => {
  it('returns APP_VERSION without a platform header (checksum omitted)', async () => {
    const res = await get('/updates/current');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('returns the dev override once set', async () => {
    setVersionOverride('9.9.9');
    const res = await get('/updates/current');
    expect(await res.json()).toEqual({ version: '9.9.9' });
  });

  it('returns the ios checksum for X-HushBox-Platform: ios', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'ios' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION, checksum: IOS_CHECKSUM });
  });

  it('returns the android checksum for X-HushBox-Platform: android', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'android' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION, checksum: ANDROID_CHECKSUM });
  });

  it('returns the android-direct checksum for X-HushBox-Platform: android-direct', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'android-direct' });
    expect(await res.json()).toEqual({
      version: SERVER_VERSION,
      checksum: ANDROID_DIRECT_CHECKSUM,
    });
  });

  it('omits the checksum for an unknown platform', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'windows' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('omits the checksum for the web platform (web never OTA-updates)', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'web' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it("omits the checksum outside production when the platform's binding is unset", async () => {
    const res = await get(
      '/updates/current',
      { NODE_ENV: 'development', APP_VERSION: SERVER_VERSION },
      { 'X-HushBox-Platform': 'ios' }
    );
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it("omits the checksum when the platform's binding is the empty string", async () => {
    const res = await get(
      '/updates/current',
      { ...baseEnv, APP_BUNDLE_CHECKSUM_IOS: '' },
      { 'X-HushBox-Platform': 'ios' }
    );
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('serves the dev checksum override ahead of the platform binding', async () => {
    setChecksumOverride('android-direct', OVERRIDE_CHECKSUM);
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'android-direct' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION, checksum: OVERRIDE_CHECKSUM });
  });

  it("serves the dev checksum override when the platform's binding is unset", async () => {
    setChecksumOverride('ios', OVERRIDE_CHECKSUM);
    const res = await get(
      '/updates/current',
      { NODE_ENV: 'development', APP_VERSION: SERVER_VERSION },
      { 'X-HushBox-Platform': 'ios' }
    );
    expect(await res.json()).toEqual({ version: SERVER_VERSION, checksum: OVERRIDE_CHECKSUM });
  });

  it('leaves other platforms on their binding when one platform is overridden', async () => {
    setChecksumOverride('android-direct', OVERRIDE_CHECKSUM);
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'ios' });
    expect(await res.json()).toEqual({ version: SERVER_VERSION, checksum: IOS_CHECKSUM });
  });

  it("serves the platform's checksum in production when its binding is published", async () => {
    const res = await get('/updates/current', productionEnv, { 'X-HushBox-Platform': 'ios' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: SERVER_VERSION, checksum: IOS_CHECKSUM });
  });

  it("fails fast (defect) when a mobile platform's checksum binding is unset in production", async () => {
    const res = await get(
      '/updates/current',
      { NODE_ENV: 'production', APP_VERSION: SERVER_VERSION },
      { 'X-HushBox-Platform': 'ios' }
    );
    expect(res.status).toBe(500);
  });

  // `Object.prototype` keys reach the platform lookup as ordinary header values,
  // so membership must be own-property membership: an inherited key resolving a
  // binding would let any anonymous caller drive the production fail-fast.
  it('omits the checksum in production for an Object.prototype key as the platform', async () => {
    const res = await get('/updates/current', productionEnv, { 'X-HushBox-Platform': 'toString' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('omits the checksum outside production for an Object.prototype key as the platform', async () => {
    const res = await get('/updates/current', baseEnv, { 'X-HushBox-Platform': 'constructor' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('omits the checksum in production without a platform header', async () => {
    const res = await get('/updates/current', productionEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });

  it('fails fast (defect) when APP_VERSION is missing', async () => {
    const res = await get('/updates/current', { NODE_ENV: 'development' });
    expect(res.status).toBe(500);
  });
});
