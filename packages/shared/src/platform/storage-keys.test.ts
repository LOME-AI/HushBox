import { describe, it, expect } from 'vitest';
import { PROMPT_PREDICTION_STUB_STORAGE_KEY, WEB_SEARCH_STORAGE_KEY } from './storage-keys.ts';

describe('storage keys', () => {
  it('pins the web-search persistence key (shared by the web store and e2e seed)', () => {
    expect(WEB_SEARCH_STORAGE_KEY).toBe('hushbox-search-storage');
  });

  it('pins the prompt-prediction arming key (shared by the e2e build variant and the e2e seed)', () => {
    expect(PROMPT_PREDICTION_STUB_STORAGE_KEY).toBe('hushbox.e2e.prompt-prediction');
  });
});
