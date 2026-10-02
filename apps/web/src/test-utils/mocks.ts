import { vi } from 'vitest';

/** Reusable mock for the HushBox logo PNG import used across native-asset tests. */
export function mockLogoImport(): void {
  vi.mock('@hushbox/ui/assets/HushBoxLogo.png', () => ({
    default: '/mocked-logo.png',
  }));
}
