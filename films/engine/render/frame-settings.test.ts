import { describe, expect, it } from 'vitest';

import { frameSettings } from './frame-settings.js';

describe('frameSettings', () => {
  it('renders the master in one tab, as lossless PNG, at full size', () => {
    expect(frameSettings(false)).toEqual({ concurrency: 1, imageFormat: 'png', scale: 1 });
  });

  it("renders a draft across Remotion's default tabs, as JPEG, at half size", () => {
    expect(frameSettings(true)).toEqual({ concurrency: null, imageFormat: 'jpeg', scale: 0.5 });
  });
});
