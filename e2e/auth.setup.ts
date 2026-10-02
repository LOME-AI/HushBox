import { test as setup } from '@playwright/test';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRequestRetry } from './helpers/resilient-request.js';
import {
  BASE_TEST_PERSONAS,
  E2E_PROJECT_NAMES,
  testPersonaName,
  type E2EProjectName,
} from '../scripts/seed.js';
import { clearAuthRateLimits } from './helpers/auth.js';
import { requireEnv } from './helpers/env.js';
import { expectOkResponse } from './helpers/ok-response.js';
import { TIMEOUTS } from './config/timeouts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '.auth');
const apiUrl = requireEnv('VITE_API_URL');

// TOTP-enrolled personas are excluded: nothing resolves a storage state for
// them (no fixture names one, and the 2FA specs drive login themselves from a
// cleared context), so minting one spent a full login-plus-OTP per project on a
// file no run reads.
const standardPersonas = BASE_TEST_PERSONAS.filter((p) => p.emailVerified && !p.totpSecret);

/** `setup-chromium` → `chromium`. */
function projectFromSetupName(setupProjectName: string): E2EProjectName {
  const stripped = setupProjectName.replace(/^setup-/, '');
  const match = E2E_PROJECT_NAMES.find((p) => p === stripped);
  if (!match) {
    throw new Error(
      `auth.setup.ts: cannot map setup project "${setupProjectName}" to a known e2e project`
    );
  }
  return match;
}

function projectAuthDir(projectName: E2EProjectName): string {
  const dir = path.join(authDir, projectName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

setup.beforeAll(() => {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
});

interface FinishSetupArgs {
  context: import('@playwright/test').BrowserContext;
  page: import('@playwright/test').Page;
  project: E2EProjectName;
  basePersonaName: string;
  personaName: string;
}

async function finishSetup({
  context,
  page,
  project,
  basePersonaName,
  personaName,
}: FinishSetupArgs): Promise<void> {
  await page.waitForURL('/chat', { timeout: TIMEOUTS.ROUTE });

  // A page-derived request context carries the page context's `baseURL` — the
  // preview server, which answers any unknown path with the SPA's index.html
  // and a 200. Naming the API origin is what makes this a real session check.
  // `withRequestRetry` has already spent its budget on a transient status by the
  // time this returns, so a non-2xx here is a settled answer, whatever its shape.
  const verifyResponse = await withRequestRetry(page.request).get(`${apiUrl}/conversations`);
  await expectOkResponse(
    verifyResponse,
    `Session verification for ${personaName}: GET ${apiUrl}/conversations`
  );

  const outputPath = path.join(projectAuthDir(project), `${basePersonaName}.json`);
  await context.storageState({ path: outputPath });
  await context.close();
}

// Standard personas: fast login via persona card. Project-specific persona
// resolved at runtime from testInfo.project.name.
for (const basePersona of standardPersonas) {
  setup(`authenticate ${basePersona.name}`, async ({ browser, request }, testInfo) => {
    const project = projectFromSetupName(testInfo.project.name);
    const personaName = testPersonaName(basePersona.name, project);

    // The persona card performs a real OPAQUE login (`/auth/login/init`),
    // which is IP-rate-limited. Each setup project presents its own caller
    // address, so the bucket is no longer common to every project — but it is
    // the address the project it authenticates uses too, and every persona of
    // that project logs in through it, so without clearing first the project's
    // own bucket accumulates, 429s mid-run, and strands the page off `/chat`.
    // No account is named: that per-IP window is the whole ask here, and a
    // login that succeeds clears the persona's own lockout on its way through.
    await clearAuthRateLimits(request, []);

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/dev/personas?type=test', { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-testid="persona-card-${personaName}"]`).click();

    await finishSetup({ context, page, project, basePersonaName: basePersona.name, personaName });
  });
}
