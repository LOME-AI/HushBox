import { describe, expect, it } from 'vitest';

import { masterAudioPath } from './master-audio.js';

describe('masterAudioPath', () => {
  it("places a film's master in a public directory named for the film", () => {
    expect(masterAudioPath('engine-render')).toBe('engine-render/master.wav');
  });
});
