import { execSync } from 'node:child_process';

export default function globalTeardown(): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- dev tooling, pnpm resolved via PATH is expected
  execSync('pnpm generate:env', { stdio: 'inherit' });
}
