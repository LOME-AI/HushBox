import { describe, expect, it } from 'vitest';
import {
  bucketingOfGrain,
  chartDatumLabel,
  LARGEST_ROW_LOWER_BOUND_NOTE,
  LOWER_BOUND_NOTE,
  perBucketCountLabel,
  summedCountLabel,
  summedQualifier,
  uniquesQualifier,
} from './summed-label.js';

describe('summedQualifier', () => {
  it('names the daily bucketing a figure was summed from', () => {
    expect(summedQualifier('daily')).toBe('daily uniques, summed');
  });

  it('names the hourly bucketing a figure was summed from', () => {
    expect(summedQualifier('hourly')).toBe('hourly uniques, summed');
  });
});

describe('uniquesQualifier', () => {
  it('names the daily bucketing a figure was counted in', () => {
    expect(uniquesQualifier('daily')).toBe('daily uniques');
  });

  it('names the hourly bucketing a figure was counted in', () => {
    expect(uniquesQualifier('hourly')).toBe('hourly uniques');
  });

  it('is the stem the summed qualifier adds its summing to', () => {
    expect(summedQualifier('daily')).toBe(`${uniquesQualifier('daily')}, summed`);
  });
});

describe('perBucketCountLabel', () => {
  it('names a figure by the bucketing it was counted in', () => {
    expect(perBucketCountLabel('Visitors', 'daily')).toBe('Visitors (daily uniques)');
  });

  it('uses the same shape for every noun, so two labels read as one claim', () => {
    expect(perBucketCountLabel('People', 'hourly')).toBe('People (hourly uniques)');
  });
});

describe('summedCountLabel', () => {
  it('parenthesises the qualifier after the figure it describes', () => {
    expect(summedCountLabel('Visitors', 'daily')).toBe('Visitors (daily uniques, summed)');
  });

  it('uses the same shape for every noun, so two labels read as one claim', () => {
    expect(summedCountLabel('People', 'hourly')).toBe('People (hourly uniques, summed)');
  });
});

describe('chartDatumLabel', () => {
  it('names the datum, then what its figure is called, then the figure', () => {
    expect(chartDatumLabel('United States', summedCountLabel('Visitors', 'daily'), '201')).toBe(
      'United States. Visitors (daily uniques, summed): 201'
    );
  });

  it('carries no long dash, which user-facing copy leaves to punctuation the reader hears', () => {
    expect(chartDatumLabel('a.com', summedCountLabel('Visitors', 'hourly'), '0')).not.toMatch(
      /[\u2013\u2014]/u
    );
  });
});

describe('LOWER_BOUND_NOTE', () => {
  it('says the figure is a floor rather than a total', () => {
    expect(LOWER_BOUND_NOTE).toMatch(/lower bound/i);
  });

  it('claims no narrowing to a largest row, for a figure that simply sums its buckets', () => {
    expect(LOWER_BOUND_NOTE).not.toMatch(/largest/i);
  });
});

describe('LARGEST_ROW_LOWER_BOUND_NOTE', () => {
  it('says the figure is a floor rather than a total', () => {
    expect(LARGEST_ROW_LOWER_BOUND_NOTE).toMatch(/lower bound/i);
  });

  it('says a bucket holding several rows keeps only the largest of them', () => {
    expect(LARGEST_ROW_LOWER_BOUND_NOTE).toMatch(/largest/i);
  });

  it('says a page is one of the things a bucket holds a row per', () => {
    expect(LARGEST_ROW_LOWER_BOUND_NOTE).toMatch(/per page/i);
  });

  it('says an event name is another, so two names on one page lose the smaller', () => {
    expect(LARGEST_ROW_LOWER_BOUND_NOTE).toMatch(/event name/i);
  });

  it('carries no long dash, which user-facing copy leaves to punctuation the reader hears', () => {
    expect(LARGEST_ROW_LOWER_BOUND_NOTE).not.toMatch(/[\u2013\u2014]/u);
  });
});

describe('bucketingOfGrain', () => {
  it('cuts a day-grain figure into daily buckets', () => {
    expect(bucketingOfGrain('day')).toBe('daily');
  });

  it('cuts an hour-grain figure into hourly buckets', () => {
    expect(bucketingOfGrain('hour')).toBe('hourly');
  });
});
