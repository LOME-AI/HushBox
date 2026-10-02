import { describe, expect, it } from 'vitest';
import { mockDirectivesSchema } from './mock-directives.ts';

describe('mockDirectivesSchema', () => {
  it('parses an empty object (the default, mock-with-default-behavior)', () => {
    expect(mockDirectivesSchema.parse({})).toEqual({});
  });

  it('parses all directive knobs', () => {
    const parsed = mockDirectivesSchema.parse({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['m1', 'm2'],
      classifierDelayMs: 25,
      textDelayMs: 60,
      mediaDelayMs: 3000,
      holdPrimaryStream: true,
    });
    expect(parsed).toEqual({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['m1', 'm2'],
      classifierDelayMs: 25,
      textDelayMs: 60,
      mediaDelayMs: 3000,
      holdPrimaryStream: true,
    });
  });

  it('rejects an empty classifierResolution', () => {
    expect(mockDirectivesSchema.safeParse({ classifierResolution: '' }).success).toBe(false);
  });

  it('rejects a false classifierFailure (only the survivable-failure literal is valid)', () => {
    expect(mockDirectivesSchema.safeParse({ classifierFailure: false }).success).toBe(false);
  });

  it('rejects an empty failingModels list', () => {
    expect(mockDirectivesSchema.safeParse({ failingModels: [] }).success).toBe(false);
  });

  it('rejects a non-positive classifierDelayMs', () => {
    expect(mockDirectivesSchema.safeParse({ classifierDelayMs: 0 }).success).toBe(false);
  });

  it('rejects a non-positive textDelayMs', () => {
    expect(mockDirectivesSchema.safeParse({ textDelayMs: 0 }).success).toBe(false);
  });

  it('rejects a non-positive mediaDelayMs', () => {
    expect(mockDirectivesSchema.safeParse({ mediaDelayMs: -1 }).success).toBe(false);
  });

  it('rejects a non-boolean holdPrimaryStream', () => {
    expect(mockDirectivesSchema.safeParse({ holdPrimaryStream: 'yes' }).success).toBe(false);
  });

  it('parses a positive holdPrimaryStreamStride', () => {
    expect(
      mockDirectivesSchema.parse({ holdPrimaryStream: true, holdPrimaryStreamStride: 2 })
    ).toEqual({ holdPrimaryStream: true, holdPrimaryStreamStride: 2 });
  });

  it('rejects a non-positive holdPrimaryStreamStride', () => {
    expect(mockDirectivesSchema.safeParse({ holdPrimaryStreamStride: 0 }).success).toBe(false);
  });

  it('rejects a fractional holdPrimaryStreamStride', () => {
    expect(mockDirectivesSchema.safeParse({ holdPrimaryStreamStride: 1.5 }).success).toBe(false);
  });

  it('parses a positive webSearchCount', () => {
    expect(mockDirectivesSchema.parse({ webSearchCount: 2 })).toEqual({ webSearchCount: 2 });
  });

  it('rejects a non-positive webSearchCount', () => {
    expect(mockDirectivesSchema.safeParse({ webSearchCount: 0 }).success).toBe(false);
  });

  it('rejects a fractional webSearchCount', () => {
    expect(mockDirectivesSchema.safeParse({ webSearchCount: 1.5 }).success).toBe(false);
  });

  it('parses a true webSearchAfterText', () => {
    expect(mockDirectivesSchema.parse({ webSearchAfterText: true })).toEqual({
      webSearchAfterText: true,
    });
  });

  it('rejects a false webSearchAfterText (only the literal true is a directive)', () => {
    expect(mockDirectivesSchema.safeParse({ webSearchAfterText: false }).success).toBe(false);
  });
});
