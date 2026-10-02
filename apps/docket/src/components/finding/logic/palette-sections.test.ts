import { describe, it, expect } from 'vitest';
import { makeFinding } from '@/test-utils/finding-fixture';
import { PALETTE_LIMIT, paletteSections } from './palette-sections';

const corpus = [
  makeFinding({ id: 'AI-1', title: 'the pool is torn down early' }),
  makeFinding({ id: 'DB-3', title: 'the ledger trigger is deferrable' }),
];

function flat(sections: ReturnType<typeof paletteSections>): readonly string[] {
  return sections.flatMap((section) => section.items.map((item) => item.id));
}

describe('paletteSections', () => {
  it('offers every finding before anything is typed', () => {
    expect(flat(paletteSections(corpus, ''))).toEqual(['AI-1', 'DB-3']);
  });

  it('shows the title, so the reader recognises the finding', () => {
    const [item] = paletteSections(corpus, '')[0]?.items ?? [];

    expect(item?.label).toBe('the pool is torn down early');
    expect(item?.hint).toBe('AI-1');
  });

  it('matches on the title', () => {
    expect(flat(paletteSections(corpus, 'ledger'))).toContain('DB-3');
  });

  it('matches on the id', () => {
    expect(flat(paletteSections(corpus, 'ai-1'))).toContain('AI-1');
  });

  it('offers nothing for a query nothing matches', () => {
    expect(flat(paletteSections(corpus, 'zzz'))).toEqual([]);
  });

  it('caps a long list so the palette stays a palette', () => {
    const many = Array.from({ length: PALETTE_LIMIT + 10 }, (_value, index) =>
      makeFinding({ id: `X-${String(index)}` })
    );

    expect(flat(paletteSections(many, ''))).toHaveLength(PALETTE_LIMIT);
  });
});
