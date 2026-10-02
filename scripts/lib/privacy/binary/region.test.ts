import { describe, expect, it } from 'vitest';

import { brotliCompressSync, deflateSync } from 'node:zlib';

import {
  MAX_DECOMPRESSED_TABLE_BYTES,
  MAX_DECOMPRESSED_TEXT_BYTES,
  MAX_EXTRACTED_TEXT_BYTES,
  MAX_INSTANTS_PER_BLOB,
  MAX_REGIONS_PER_BLOB,
  MAX_TOTAL_EXTRACTED_TEXT_BYTES,
  RegionCollector,
  boundedText,
  brotliBounded,
  extractPrintableText,
  inflateBounded,
  printableStructuralName,
} from './region.js';

const bytesOf = (parts: readonly (string | number)[]): Uint8Array => {
  const chunks = parts.map((part) =>
    typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.alloc(part)
  );
  return Buffer.concat(chunks);
};

describe('extractPrintableText', () => {
  it('returns the printable runs inside the range', () => {
    const bytes = bytesOf([4, 'hello', 4, 'world', 4]);
    expect(extractPrintableText(bytes, 0, bytes.length)).toBe('hello\nworld');
  });

  it('drops runs shorter than the minimum length', () => {
    const bytes = bytesOf([4, 'ab', 4, 'legible', 4]);
    expect(extractPrintableText(bytes, 0, bytes.length)).toBe('legible');
  });

  it('confines extraction to the requested range', () => {
    const bytes = bytesOf(['before', 4, 'after']);
    expect(extractPrintableText(bytes, 6, bytes.length)).toBe('after');
  });

  it('closes a run that reaches the end of the range', () => {
    const bytes = bytesOf([4, 'trailing']);
    expect(extractPrintableText(bytes, 0, bytes.length)).toBe('trailing');
  });

  /**
   * The printable-run band and its length floor, at their edges. The run
   * extraction is what makes every value rule applicable to a binary region, so
   * a byte wrongly inside or outside this band changes what the gate can see at
   * all.
   */
  it('keeps a run of exactly the minimum length', () => {
    expect(extractPrintableText(Buffer.from('abcd', 'latin1'), 0, 4)).toBe('abcd');
  });

  it('drops a run one character short of it', () => {
    expect(extractPrintableText(Buffer.from('abc', 'latin1'), 0, 3)).toBe('');
  });

  it('keeps the characters at both edges of the printable band', () => {
    expect(extractPrintableText(Buffer.from(' ~ab', 'latin1'), 0, 4)).toBe(' ~ab');
  });

  it.each([0x1f, 0x7f])('breaks a run at the byte one step outside an edge (%i)', (byte) => {
    const bytes = Buffer.concat([
      Buffer.from('abcd', 'latin1'),
      Buffer.from([byte]),
      Buffer.from('efgh', 'latin1'),
    ]);
    expect(extractPrintableText(bytes, 0, bytes.length)).toBe(['abcd', 'efgh'].join('\n'));
  });

  it('returns an empty string when nothing is printable', () => {
    expect(extractPrintableText(bytesOf([32]), 0, 32)).toBe('');
  });

  /**
   * Edge written as a literal rather than read from the constant it pins. A
   * fixture sized by the value under test moves with it, so the assertion holds
   * whatever the cap becomes and can never fail for its own subject.
   */
  it('extracts exactly as many characters as the cap allows', () => {
    const bytes = Buffer.from('abcdefgh'.repeat(20_000), 'latin1');
    expect(extractPrintableText(bytes, 0, bytes.length)).toHaveLength(65_536);
  });

  /**
   * Written against the literal size rather than the constant. A test that reads
   * the constant moves with any mutation of it and can pin nothing. The tree's
   * C2PA manifests yield roughly eight thousand characters of printable runs, so
   * a cap below that silently stops scanning real disclosures.
   */
  it('extracts far more than a few hundred bytes, which real manifests need', () => {
    const bytes = Buffer.from('a'.repeat(20_000), 'latin1');
    expect(extractPrintableText(bytes, 0, bytes.length).length).toBe(20_000);
  });

  it('finds a value sitting past the first few hundred bytes of a region', () => {
    // Assembled at runtime; see the specimen note in `leak-values.test.ts`.
    const specimen = ['', 'home', 'someone', 'x'].join('/');
    const bytes = Buffer.from(`${'a'.repeat(9000)} ${specimen}`, 'latin1');
    expect(extractPrintableText(bytes, 0, bytes.length)).toContain(specimen);
  });

  it('keeps a printable run at the minimum run length', () => {
    const bytes = Buffer.concat([Buffer.alloc(4), Buffer.from('abcd', 'latin1'), Buffer.alloc(4)]);
    expect(extractPrintableText(bytes, 0, bytes.length)).toBe('abcd');
  });

  it('clamps a range that runs past the end of the buffer', () => {
    const bytes = bytesOf(['visible']);
    expect(extractPrintableText(bytes, 0, bytes.length + 500)).toBe('visible');
  });

  it('returns an empty string for an inverted range', () => {
    expect(extractPrintableText(bytesOf(['visible']), 6, 2)).toBe('');
  });
});

/**
 * These feed *valid* compressed data that expands past the ceiling. Input that
 * merely fails to decode exercises "will not decode" and never "will not fit",
 * so it leaves the cap — the whole remedy for the decompression amplifier —
 * pinned by nothing while reading as though it were.
 */
const region = (text: string): Parameters<RegionCollector['push']>[0] => ({
  kind: 'test:region',
  location: 'here',
  offset: 0,
  length: 1,
  text,
  instants: [],
  carriesIdentity: false,
});

describe('inflateBounded', () => {
  it('returns the payload when it expands inside the cap', () => {
    const payload = Buffer.alloc(1024, 0x41);
    expect(inflateBounded(deflateSync(payload))?.length).toBe(payload.length);
  });

  it('refuses a payload that expands past the cap', () => {
    const payload = Buffer.alloc(MAX_DECOMPRESSED_TEXT_BYTES + 1, 0x41);
    expect(inflateBounded(deflateSync(payload))).toBeUndefined();
  });

  it('refuses input that is not deflate at all', () => {
    expect(inflateBounded(Buffer.alloc(8, 0xff))).toBeUndefined();
  });
});

describe('brotliBounded', () => {
  it('returns the payload when it expands inside the ceiling it was given', () => {
    const payload = Buffer.alloc(1024, 0x41);
    expect(brotliBounded(brotliCompressSync(payload), MAX_DECOMPRESSED_TEXT_BYTES)?.length).toBe(
      payload.length
    );
  });

  it('refuses a payload that expands past the text ceiling', () => {
    const payload = Buffer.alloc(MAX_DECOMPRESSED_TEXT_BYTES + 1, 0x41);
    expect(brotliBounded(brotliCompressSync(payload), MAX_DECOMPRESSED_TEXT_BYTES)).toBeUndefined();
  });

  /**
   * The table ceiling's own value is pinned by the policy bound below rather
   * than by compressing sixteen mebibytes here: that payload took thirty-five
   * seconds and exceeded the suite's own timeout under coverage. What this pair
   * pins is the mechanism — that the ceiling passed in is the ceiling applied —
   * and `parseWoff2` is what passes the table ceiling to it.
   */
  it('applies the ceiling it is given rather than a ceiling of its own', () => {
    const payload = Buffer.alloc(2048, 0x41);
    const compressed = brotliCompressSync(payload);
    expect(brotliBounded(compressed, 1024)).toBeUndefined();
    expect(brotliBounded(compressed, MAX_DECOMPRESSED_TABLE_BYTES)?.length).toBe(payload.length);
  });
});

describe('boundedText', () => {
  it('leaves a string inside the cap alone', () => {
    expect(boundedText('short')).toBe('short');
  });

  it('truncates a string past the cap to the cap', () => {
    expect(boundedText('a'.repeat(70_000))).toHaveLength(65_536);
  });

  it('leaves a string of exactly the cap alone', () => {
    expect(boundedText('a'.repeat(65_536))).toHaveLength(65_536);
  });
});

/**
 * The unit that was wrong in the first fix: bytes were capped per region while
 * nothing capped regions per blob, so a file whose entries all alias one image
 * multiplied the parse by the entry count and ended in a heap-limit abort.
 */
describe('RegionCollector', () => {
  it('collects regions while the budget holds', () => {
    const collector = new RegionCollector();
    collector.push(region('a'));
    expect(collector.collect(10)).toHaveLength(1);
    expect(collector.exhausted).toBe(false);
  });

  it('stops accepting regions past the count ceiling', () => {
    const collector = new RegionCollector();
    for (let index = 0; index <= 4096; index++) collector.push(region(''));
    expect(collector.exhausted).toBe(true);
    // The ceiling's own regions plus the refusal `collect` appends for stopping.
    expect(collector.collect(10)).toHaveLength(4097);
  });

  it('is not exhausted one region short of that ceiling', () => {
    const collector = new RegionCollector();
    for (let index = 0; index < 4095; index++) collector.push(region(''));
    expect(collector.exhausted).toBe(false);
  });

  /**
   * The count and text ceilings bound the *containers* of a disclosure. One
   * archive extra field holds thousands of timestamp attributes, so a blob can
   * stay far inside both while the finding list does not.
   */
  const timed = (instants: number): Parameters<RegionCollector['push']>[0] => ({
    ...region(''),
    instants: Array.from({ length: instants }, () => ({ field: 'when', secondsUtc: 1 })),
  });

  it('stops accepting regions past the instant ceiling', () => {
    const collector = new RegionCollector();
    for (let index = 0; index < 65; index++) collector.push(timed(1024));
    expect(collector.exhausted).toBe(true);
  });

  it('is not exhausted at exactly that ceiling', () => {
    const collector = new RegionCollector();
    for (let index = 0; index < 64; index++) collector.push(timed(1024));
    expect(collector.exhausted).toBe(false);
  });

  it('stops accepting regions past the total-text ceiling', () => {
    const collector = new RegionCollector();
    const chunk = 'a'.repeat(MAX_EXTRACTED_TEXT_BYTES);
    for (let index = 0; index <= MAX_TOTAL_EXTRACTED_TEXT_BYTES / chunk.length; index++) {
      collector.push(region(chunk));
    }
    expect(collector.exhausted).toBe(true);
  });

  it('appends a refusal when the budget stopped the parse', () => {
    const collector = new RegionCollector();
    for (let index = 0; index <= MAX_REGIONS_PER_BLOB; index++) collector.push(region(''));
    const collected = collector.collect(10);
    expect(collected.at(-1)?.malformed).toBeDefined();
    expect(collected.at(-1)?.kind).toBe('blob:budget');
  });

  it('appends nothing when the budget was never spent', () => {
    const collector = new RegionCollector();
    collector.pushAll([region('a'), region('b')]);
    expect(collector.collect(10).every((entry) => entry.malformed === undefined)).toBe(true);
  });
});

describe('printableStructuralName', () => {
  it('accepts a plain ASCII structural name', () => {
    expect(printableStructuralName('moov')).toBe('moov');
  });

  it('accepts the copyright sign that opens an iTunes-style atom name', () => {
    expect(printableStructuralName('\u00A9too')).toBe('\u00A9too');
  });

  /**
   * Both edges of the printable band, written as literals rather than derived
   * from the constants they pin: a fixture computed from the value under test
   * moves with it and asserts nothing.
   */
  it('accepts a name whose bytes sit at the low edge of the printable band', () => {
    expect(printableStructuralName('a\u0020b\u0020')).toBe('a\u0020b\u0020');
  });

  it('rejects a name one byte below that edge', () => {
    expect(printableStructuralName('a\u001Fb\u0020')).toBeUndefined();
  });

  it('accepts a name whose bytes sit at the high edge of the printable band', () => {
    expect(printableStructuralName('a\u007Eb\u007E')).toBe('a\u007Eb\u007E');
  });

  it('rejects a name one byte above that edge', () => {
    expect(printableStructuralName('a\u007Fb\u007E')).toBeUndefined();
  });

  it('rejects a name carrying a control byte', () => {
    expect(printableStructuralName('a\u001Bb')).toBeUndefined();
  });
});

/**
 * The ceilings are policy, and the mechanism tests above cannot pin them: a
 * mutant that raises one to two gigabytes would make the test that feeds
 * "one byte past the cap" allocate two gigabytes rather than fail. These pin
 * that each ceiling stays bounded, which is the property the amplifier
 * measurements bought.
 */
describe('the decompression ceilings', () => {
  const SIXTY_FOUR_MEBIBYTES = 67_108_864;

  it('keeps the text ceiling far below what a gate process can absorb', () => {
    expect(MAX_DECOMPRESSED_TEXT_BYTES).toBeGreaterThan(MAX_EXTRACTED_TEXT_BYTES);
    expect(MAX_DECOMPRESSED_TEXT_BYTES).toBeLessThan(SIXTY_FOUR_MEBIBYTES);
  });

  it('keeps the table ceiling bounded even though a font is larger than a packet', () => {
    expect(MAX_DECOMPRESSED_TABLE_BYTES).toBeGreaterThan(MAX_DECOMPRESSED_TEXT_BYTES);
    expect(MAX_DECOMPRESSED_TABLE_BYTES).toBeLessThan(SIXTY_FOUR_MEBIBYTES);
  });

  it('keeps the per-blob budget bounded', () => {
    expect(MAX_TOTAL_EXTRACTED_TEXT_BYTES).toBeLessThan(SIXTY_FOUR_MEBIBYTES);
    expect(MAX_REGIONS_PER_BLOB).toBeLessThan(100_000);
    expect(MAX_INSTANTS_PER_BLOB).toBeLessThan(100_000);
  });

  describe('RegionCollector once exhausted', () => {
    it('accepts nothing further once the budget is spent', () => {
      const collector = new RegionCollector();
      for (let index = 0; index <= MAX_REGIONS_PER_BLOB; index++) collector.push(region(''));
      const spent = collector.collect(10).length;
      collector.push(region('more'));
      expect(collector.collect(10)).toHaveLength(spent);
    });
  });
});
