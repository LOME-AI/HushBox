import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { splitLastWord } from './split-last-word';

// Titles built from letters, accents, emoji, punctuation and every kind of
// whitespace a title can carry (spaces, tabs, newlines, no-break spaces), so
// runs of separators and leading or trailing whitespace are common.
const titleCharacter = fc.constantFrom(
  'a',
  'Z',
  'é',
  '🎉',
  '-',
  '.',
  ',',
  '!',
  '(',
  ')',
  '"',
  ' ',
  '  ',
  '\t',
  '\n',
  ' ',
  '　'
);
const title = fc.string({ unit: titleCharacter });

function lastWordOf(text: string): string {
  return text.trim().split(/\s+/).at(-1) ?? '';
}

describe('splitLastWord', () => {
  it('rebuilds the trimmed title from lead and last, for generated titles', () => {
    fc.assert(
      fc.property(title, (generated) => {
        const { lead, last } = splitLastWord(generated);
        expect(lead + last).toBe(generated.trim());
      })
    );
  });

  it('returns the title’s last word as last, for generated titles', () => {
    fc.assert(
      fc.property(title, (generated) => {
        expect(splitLastWord(generated).last).toBe(lastWordOf(generated));
      })
    );
  });

  it('rebuilds any string, not only title-like ones', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (generated) => {
        const { lead, last } = splitLastWord(generated);
        expect(lead + last).toBe(generated.trim());
        expect(last).toBe(lastWordOf(generated));
      })
    );
  });

  it('takes the final word as last and everything before it as lead', () => {
    expect(splitLastWord('Save and reuse prompt presets')).toEqual({
      lead: 'Save and reuse prompt ',
      last: 'presets',
    });
  });

  it('keeps punctuation attached to the final word', () => {
    expect(splitLastWord('Fix bug (mobile).')).toEqual({ lead: 'Fix bug ', last: '(mobile).' });
  });

  it('treats a trailing no-break space as whitespace to trim', () => {
    expect(splitLastWord('Ends in a no-break space ')).toEqual({
      lead: 'Ends in a no-break ',
      last: 'space',
    });
  });

  it('returns a one-word title whole as last with an empty lead', () => {
    expect(splitLastWord('Typing')).toEqual({ lead: '', last: 'Typing' });
  });

  it('returns two empty parts for a blank title', () => {
    expect(splitLastWord(' \t ')).toEqual({ lead: '', last: '' });
  });
});
