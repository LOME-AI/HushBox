import { describe, expect, it } from 'vitest';
import { FEEDBACK_BODY_MAX_LENGTH } from './feedback.ts';

describe('FEEDBACK_BODY_MAX_LENGTH', () => {
  it('is the 4000-character feedback body cutoff', () => {
    expect(FEEDBACK_BODY_MAX_LENGTH).toBe(4000);
  });
});
