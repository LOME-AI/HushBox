import { describe, expect, it } from 'vitest';
import { ANONYMOUS_STEP_NOTE, BUCKET_MAXIMUM_NOTE } from './funnel-steps.ts';

describe('ANONYMOUS_STEP_NOTE', () => {
  it('says what makes a step anonymous rather than how many steps are', () => {
    expect(ANONYMOUS_STEP_NOTE).toMatch(/no account identity/i);
    expect(ANONYMOUS_STEP_NOTE).not.toMatch(/\b(two|three)\b/i);
  });

  it('says how the dashboard draws an anonymous step, so the reader can tell one', () => {
    expect(ANONYMOUS_STEP_NOTE).toMatch(/hatch/i);
  });
});

describe('BUCKET_MAXIMUM_NOTE', () => {
  it('says a step whose bucket holds several rows keeps the largest of them', () => {
    expect(BUCKET_MAXIMUM_NOTE).toMatch(/largest/i);
  });

  it('says the figure such a step reports is a lower bound', () => {
    expect(BUCKET_MAXIMUM_NOTE).toMatch(/lower bound/i);
  });

  it('states what a step takes rather than counting the steps that take it', () => {
    expect(BUCKET_MAXIMUM_NOTE).not.toMatch(/\b(two|three)\b/i);
  });
});
