import { describe, expect, it } from 'vitest';
import { dimensionOptionAvailability } from './media-option-availability.ts';
import type { MediaDimensionAvailability } from './turn/media-core.ts';

/** One produced axis, carrying exactly the options the money layer graded. */
function produced(
  dimensionId: 'aspectRatio' | 'resolution',
  graded: readonly (readonly [string, boolean])[]
): readonly MediaDimensionAvailability[] {
  const [first, ...rest] = graded.map(([optionId, available]) => ({
    optionId,
    label: optionId,
    availability: available
      ? ({ available: true } as const)
      : ({ available: false, reason: 'insufficient_funds' } as const),
  }));
  if (first === undefined) throw new Error('graded must not be empty');
  return [{ dimensionId, options: [first, ...rest] }];
}

describe('one option read off a produced media verdict', () => {
  it('answers the verdict the money layer graded that option with', () => {
    const dimensions = produced('resolution', [
      ['720p', true],
      ['1080p', false],
    ]);

    expect(dimensionOptionAvailability(dimensions, 'resolution', '1080p')).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  it('answers available for an option the money layer graded as affordable', () => {
    const dimensions = produced('resolution', [['720p', true]]);

    expect(dimensionOptionAvailability(dimensions, 'resolution', '720p')).toEqual({
      available: true,
    });
  });

  it('reads the axis it was asked about rather than the first one produced', () => {
    const dimensions = [
      ...produced('aspectRatio', [['16:9', false]]),
      ...produced('resolution', [['720p', true]]),
    ];

    expect(dimensionOptionAvailability(dimensions, 'resolution', '720p')).toEqual({
      available: true,
    });
  });

  it('refuses an option the produced set does not grade', () => {
    const dimensions = produced('resolution', [['720p', true]]);

    expect(dimensionOptionAvailability(dimensions, 'resolution', '4k')).toEqual({
      available: false,
      reason: 'option_not_offered',
    });
  });

  it('refuses every option of an axis the produced set does not carry', () => {
    const dimensions = produced('aspectRatio', [['16:9', true]]);

    expect(dimensionOptionAvailability(dimensions, 'resolution', '720p')).toEqual({
      available: false,
      reason: 'option_not_offered',
    });
  });

  it('leaves an option alone while no verdict has been produced at all', () => {
    expect(dimensionOptionAvailability(undefined, 'resolution', '720p')).toEqual({
      available: true,
    });
  });
});
