import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { requireEnv } from '../helpers/env.js';
import { guestIp } from '../helpers/guest-identity.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { E2E_SEEDED_VIDEO_MODEL_IDS } from '../../scripts/lib/playwright/model-ids.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    "Both tests POST to the trial route through the page's request context and assert the 403 body code; the eligibility gate they prove answers before a run starts and nothing here is drawn.",
});

const apiUrl = requireEnv('VITE_API_URL');

/**
 * Trial media is blocked at the send. The trial route (`POST /chat/trial`) is
 * the only unauthenticated send path; it refuses any non-text model at the
 * eligibility gate — before the quota INCR and before the run starts — with
 * `403 { code: 'MEDIA_TRIAL_BLOCKED' }` (chat `trialGateRejection`,
 * mirrored by the slice's `routes.integration.test.ts`).
 *
 * The old backend had a distinct link-guest media block; the new architecture
 * lets a write-privileged link guest generate owner-funded media, so that
 * contract no longer exists (see this file's re-point notes). Both cases here
 * exercise the surviving trial gate — image and video — since that is the one
 * `MEDIA_TRIAL_BLOCKED` surface the code still emits.
 *
 * Both tests carry the guest identity so the trial per-IP burst throttle
 * (which runs before the media gate) counts against a window no other project
 * and no concurrently-running worker shares, and so cannot pre-empt the block
 * with a 429. That window is one of the few this suite never clears — it
 * expires on its own 60s — so what keeps it clear is the identity, not a
 * reset. The `Idempotency-Key`
 * is required by the pipeline on this mutating route; its value is immaterial
 * because the gate answers 403 before the run referee is ever claimed.
 */
test.describe('Trial Media Blocked', SPEC_MATRIX, () => {
  test('trial send with an image model is blocked with MEDIA_TRIAL_BLOCKED', async ({
    unauthenticatedPage,
  }) => {
    const response = await withRequestRetry(unauthenticatedPage.request).post(
      `${apiUrl}/chat/trial`,
      {
        headers: {
          'Idempotency-Key': 'trial-media-blocked-image',
          'cf-connecting-ip': guestIp(),
        },
        data: {
          turnSources: [{ kind: 'model', id: 'bytedance-seed/seedream-4.5' }],
          prompt: 'Trial image attempt',
        },
      }
    );

    expect(response.status()).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe('MEDIA_TRIAL_BLOCKED');
  });

  test('trial send with a video model is blocked with MEDIA_TRIAL_BLOCKED', async ({
    unauthenticatedPage,
  }) => {
    const response = await withRequestRetry(unauthenticatedPage.request).post(
      `${apiUrl}/chat/trial`,
      {
        headers: {
          'Idempotency-Key': 'trial-media-blocked-video',
          'cf-connecting-ip': guestIp(),
        },
        data: {
          turnSources: [{ kind: 'model', id: E2E_SEEDED_VIDEO_MODEL_IDS[0] }],
          prompt: 'Trial video attempt',
        },
      }
    );

    expect(response.status()).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe('MEDIA_TRIAL_BLOCKED');
  });
});
