import { describe, it, expect } from 'vitest';
import { makeFinding } from '@/test-utils/finding-fixture';
import { currentIn, landAnnouncement, stepAnnouncement, stepFrom } from './queue-step';
import type { FindingJson } from '@hushbox/docket';

const queue: readonly FindingJson[] = [
  makeFinding({ id: 'A-1' }),
  makeFinding({ id: 'A-2' }),
  makeFinding({ id: 'A-3' }),
];

describe('currentIn', () => {
  it('resolves the focused finding', () => {
    expect(currentIn(queue, 'A-2')?.id).toBe('A-2');
  });

  it('falls back to the head of the queue when nothing is focused', () => {
    expect(currentIn(queue, null)?.id).toBe('A-1');
  });

  it('falls back to the head when the focused id is not in this queue', () => {
    expect(currentIn(queue, 'Z-9')?.id).toBe('A-1');
  });

  it('resolves to nothing in an empty queue', () => {
    expect(currentIn([], 'A-1')).toBeUndefined();
  });
});

describe('stepFrom', () => {
  it('moves forward', () => {
    expect(stepFrom(queue, 'A-1', 1)?.id).toBe('A-2');
  });

  it('moves back', () => {
    expect(stepFrom(queue, 'A-3', -1)?.id).toBe('A-2');
  });

  it('stops at the end rather than wrapping', () => {
    expect(stepFrom(queue, 'A-3', 1)).toBeUndefined();
  });

  it('stops at the start rather than wrapping', () => {
    expect(stepFrom(queue, 'A-1', -1)).toBeUndefined();
  });

  it('takes the head of the queue when nothing is current yet', () => {
    expect(stepFrom(queue, null, 1)?.id).toBe('A-1');
  });

  it('takes the head when the current id has left the queue', () => {
    expect(stepFrom(queue, 'Z-9', 1)?.id).toBe('A-1');
  });

  it('has nowhere to go in an empty queue', () => {
    expect(stepFrom([], null, 1)).toBeUndefined();
  });
});

describe('stepAnnouncement', () => {
  const queue = [
    makeFinding({ id: 'A-1' }),
    makeFinding({ id: 'A-2' }),
    makeFinding({ id: 'A-3' }),
  ];

  it('names the finding stepped to and where it sits in the queue', () => {
    expect(stepAnnouncement(queue, 'A-2')).toBe('A-2. 2 of 3.');
  });

  it('says nothing about a finding the queue does not hold', () => {
    expect(stepAnnouncement(queue, 'Z-9')).toBe('');
  });
});

describe('landAnnouncement', () => {
  it('names the finding the reader was moved to', () => {
    expect(landAnnouncement('A-2')).toBe('Moved to A-2.');
  });
});
