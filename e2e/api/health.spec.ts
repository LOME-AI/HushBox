import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { requireEnv } from '../helpers/env.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The test issues one HTTP GET to the API and asserts the JSON status body; no page is navigated, so no rendering engine takes part.',
});

const apiUrl = requireEnv('VITE_API_URL');

test.describe('API Health Endpoint', SPEC_MATRIX, () => {
  test('GET /health returns 200 with status ok', async ({ request }) => {
    const response = await request.get(`${apiUrl}/health`);

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status: string; timestamp: string };
    expect(body).toHaveProperty('status', 'ok');
    expect(body).toHaveProperty('timestamp');
  });
});
