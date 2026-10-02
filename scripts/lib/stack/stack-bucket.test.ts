import { describe, it, expect } from 'vitest';
import { STACK_BUCKET_MARKER } from '@hushbox/shared/env.config';
import { STACK_MODES } from './port-plan.js';
import {
  STACK_BUCKET_VARIABLES,
  applyStackBucket,
  mediaBucketFrom,
  mediaBucketName,
  stackBucketList,
  stackBucketsFrom,
} from './stack-bucket.js';

/** What MinIO and S3 both accept as a bucket name. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

describe('mediaBucketName', () => {
  it('keeps the default stack on the bucket its volume already holds', () => {
    expect(mediaBucketName('development')).toBe('hushbox-media-dev');
  });

  it('gives every stack a bucket no other stack owns', () => {
    const names = STACK_MODES.map((stackMode) => mediaBucketName(stackMode));

    expect(new Set(names).size).toBe(names.length);
  });

  it.each([...STACK_MODES])('gives the %s stack a name the object store accepts', (stackMode) => {
    expect(mediaBucketName(stackMode)).toMatch(BUCKET_NAME);
  });
});

describe('applyStackBucket', () => {
  it('substitutes the marker with the bucket of the stack being written', () => {
    expect(applyStackBucket(STACK_BUCKET_MARKER, 'e2e')).toBe(mediaBucketName('e2e'));
  });

  it('leaves a value naming no bucket alone', () => {
    expect(applyStackBucket('minioadmin', 'e2e')).toBe('minioadmin');
  });
});

describe('mediaBucketFrom', () => {
  it('answers with the bucket the loaded environment names', () => {
    expect(mediaBucketFrom({ R2_BUCKET_MEDIA: 'hushbox-media-e2e' })).toBe('hushbox-media-e2e');
  });

  it.each([
    ['unset', {}],
    ['empty', { R2_BUCKET_MEDIA: '' }],
  ])('refuses an environment that names none, %s', (_case, env: NodeJS.ProcessEnv) => {
    expect(() => mediaBucketFrom(env)).toThrow('R2_BUCKET_MEDIA');
  });
});

describe('stackBucketsFrom', () => {
  const named = Object.fromEntries(
    STACK_BUCKET_VARIABLES.map((name, index) => [name, `bucket-${String(index)}`])
  );

  it('answers with every bucket the loaded environment names, in one list', () => {
    expect(stackBucketsFrom(named)).toEqual(
      STACK_BUCKET_VARIABLES.map((_, index) => `bucket-${String(index)}`)
    );
  });

  it.each([...STACK_BUCKET_VARIABLES])('refuses an environment naming no %s', (variable) => {
    const short = { ...named };
    Reflect.deleteProperty(short, variable);

    expect(() => stackBucketsFrom(short)).toThrow(variable);
  });
});

describe('stackBucketList', () => {
  it('spells every bucket the environment names as one word-splittable list', () => {
    const named = Object.fromEntries(
      STACK_BUCKET_VARIABLES.map((name, index) => [name, `bucket-${String(index)}`])
    );

    expect(stackBucketList(named).split(' ')).toEqual(stackBucketsFrom(named));
  });

  it('refuses an environment naming no bucket for one of them', () => {
    expect(() => stackBucketList({})).toThrow(STACK_BUCKET_VARIABLES[0]);
  });
});
