import { describe, expect, it } from 'vitest';
import { recordsRemote } from './remote.js';

describe('recordsRemote', () => {
  it('is the GitHub https URL of the records repository', () => {
    expect(
      recordsRemote({
        publicRepo: 'Example-Org/Example',
        stagingRepo: 'Example-Org/Example-staging',
        recordsRepo: 'Example-Org/Example-records',
      })
    ).toBe('https://github.com/Example-Org/Example-records.git');
  });
});
