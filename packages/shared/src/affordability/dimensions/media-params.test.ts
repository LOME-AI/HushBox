import { describe, expect, it } from 'vitest';

import { MEDIA_PARAMETER_NAMES, mediaParameterSpecs } from './media-params.ts';
import { MEDIA_DIMENSION_IDS } from './types.ts';

describe('MEDIA_PARAMETER_NAMES', () => {
  it('names a catalog parameter for every media dimension id', () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(MEDIA_PARAMETER_NAMES).toSorted(byName)).toEqual(
      [...MEDIA_DIMENSION_IDS].toSorted(byName)
    );
  });
});

describe('mediaParameterSpecs', () => {
  it('mints a providerOptions enum spec under the declared axis name', () => {
    expect(mediaParameterSpecs({ aspectRatio: ['1:1', '16:9'] })).toEqual({
      aspectRatio: { type: 'enum', values: ['1:1', '16:9'], wire: 'providerOptions' },
    });
  });

  it('omits an axis whose declared domain is empty', () => {
    expect(mediaParameterSpecs({ aspectRatio: ['1:1'], resolution: [] })).toEqual({
      aspectRatio: { type: 'enum', values: ['1:1'], wire: 'providerOptions' },
    });
  });

  it('refuses an axis name that is not a media dimension', () => {
    // @ts-expect-error -- `aspect_ratio` is not a media dimension id, so a
    // renamed axis fails to compile at the mint site rather than minting a spec
    // nothing reads.
    expect(mediaParameterSpecs({ aspect_ratio: ['1:1'] })).toEqual({});
  });
});
