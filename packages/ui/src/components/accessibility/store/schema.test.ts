import { describe, it, expect } from 'vitest';
import {
  accessibilityPreferencesSchema,
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
  type AccessibilityPreferences,
} from './schema';

describe('accessibility schema re-exports', () => {
  it('re-exports the parsed defaults from @hushbox/shared', () => {
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.theme).toBe('system');
    expect(ACCESSIBILITY_PREFERENCES_DEFAULTS.version).toBe(1);
  });

  it('re-exports a Zod schema that parses the defaults', () => {
    const parsed: AccessibilityPreferences = accessibilityPreferencesSchema.parse({ version: 1 });
    expect(parsed.contrast).toBe('normal');
  });
});
