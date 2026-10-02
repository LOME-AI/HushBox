import { describe, expect, it } from 'vitest';

import { adminPreviewPath } from './admin-preview.ts';

describe('adminPreviewPath', () => {
  it('names the framed copy of a site page under the prefix the admin origin serves it at', () => {
    expect(adminPreviewPath('/welcome')).toBe('/preview/welcome/');
  });

  it('keeps the segments of a nested page between the prefix and the slash', () => {
    expect(adminPreviewPath('/newsletter/confirmed')).toBe('/preview/newsletter/confirmed/');
  });
});
