import { test, expect } from '@playwright/test';

test.describe('API Health Endpoint', () => {
  test('GET /api/health returns 200 with status ok', async ({ request }) => {
    const response = await request.get('http://localhost:8787/api/health');

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status: string; timestamp: string };
    expect(body).toHaveProperty('status', 'ok');
    expect(body).toHaveProperty('timestamp');
  });
});
