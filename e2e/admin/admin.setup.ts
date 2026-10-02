import { expect, test as setup } from '@playwright/test';
import { adminOpsCatalogSchema, devAdminTokenResponseSchema } from '@hushbox/shared';
import { expectOkResponse } from '../helpers/ok-response.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';

/**
 * The admin plane's shared preconditions, proven once before any admin spec
 * runs. Every request goes to the admin preview's own origin, the project's
 * base URL, because its `/api` proxy to the Worker is one of the
 * preconditions. The preview answers any path outside that proxy with the
 * SPA's document and a 200, so each proxied answer is read as the Worker's
 * JSON rather than trusted on its status.
 *
 * It never reads `/admin/dashboard`: that read is metered per actor, and the
 * `adminPage` fixture spends the budget on every test that takes it.
 */
setup('the admin preview reaches the Worker as the default dev actor', async ({ request }) => {
  const preview = withRequestRetry(request);

  const shell = await preview.get('/');
  await expectOkResponse(shell, 'admin preview shell read', 200);
  expect(shell.headers()['content-type']).toMatch(/^text\/html/);

  const mint = await preview.get('/api/dev/admin-token', {
    params: { email: DEV_ADMIN_ACTORS[0] },
  });
  await expectOkResponse(mint, 'dev admin token mint through the preview proxy', 200);
  const { token, header } = devAdminTokenResponseSchema.parse(await mint.json());

  const catalog = await preview.get('/api/admin/ops', { headers: { [header]: token } });
  await expectOkResponse(catalog, 'admin ops catalog read through the preview proxy', 200);
  expect(adminOpsCatalogSchema.parse(await catalog.json()).ops).not.toHaveLength(0);
});
