import { describe, expect, it } from 'vitest';

import {
  contentHash,
  contentSpans,
  mergeSpans,
  overlappingBytes,
  totalSpanBytes,
} from './binary-content.js';
import {
  FLAC_SIGNATURE,
  FLAC_TYPE_PADDING,
  FLAC_TYPE_STREAMINFO,
  ISO_FTYP,
  MATROSKA_ID_CLUSTER,
  MATROSKA_ID_EBML,
  MATROSKA_ID_SEGMENT,
  ascii,
  concat,
  ebmlElement,
  filled,
  flacAudio,
  flacBlock,
  gif,
  id3Frame,
  id3Tag,
  isoBox,
  mp3Audio,
  png,
  pngChunk,
  pngTextChunk,
} from '../__test-fixtures-binary-strip__/media.js';

const IMAGE_DATA = filled(64, 0x5a);
const AUDIO = flacAudio();

function spanBytes(bytes: Uint8Array): Buffer {
  const spans = contentSpans(bytes);
  expect(spans).toBeDefined();
  return Buffer.concat(
    (spans ?? []).map((span) => Buffer.from(bytes.subarray(span.start, span.end)))
  );
}

describe('locating a container’s content', () => {
  it('finds a PNG’s image data and nothing else', () => {
    const bytes = png({
      ancillary: [pngTextChunk('Software', 'Matplotlib 3.9.0')],
      imageData: IMAGE_DATA,
    });
    expect(spanBytes(bytes).equals(Buffer.from(IMAGE_DATA))).toBe(true);
  });

  it('joins a PNG’s image data across several chunks', () => {
    const bytes = concat(
      png({ imageData: filled(16, 0x01) }).subarray(0, 8 + 25),
      pngChunk('IDAT', filled(16, 0x01)),
      pngChunk('IDAT', filled(16, 0x02)),
      pngChunk('IEND', new Uint8Array(0))
    );
    expect(spanBytes(bytes).equals(Buffer.concat([filled(16, 0x01), filled(16, 0x02)]))).toBe(true);
  });

  it('finds an ISO base-media file’s coded samples', () => {
    const coded = filled(48, 0x37);
    expect(spanBytes(concat(ISO_FTYP, isoBox('mdat', coded))).equals(Buffer.from(coded))).toBe(
      true
    );
  });

  it('finds a FLAC stream’s audio frames behind its metadata blocks', () => {
    const bytes = concat(
      FLAC_SIGNATURE,
      flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)),
      flacBlock(FLAC_TYPE_PADDING, filled(16, 0), true),
      AUDIO
    );
    expect(spanBytes(bytes).equals(Buffer.from(AUDIO))).toBe(true);
  });

  it('finds a FLAC stream’s audio frames behind an ID3 prefix as well', () => {
    const bytes = concat(
      id3Tag([id3Frame('GEOB', ascii('manifest'))]),
      FLAC_SIGNATURE,
      flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)),
      flacBlock(FLAC_TYPE_PADDING, filled(8, 0), true),
      AUDIO
    );
    expect(spanBytes(bytes).equals(Buffer.from(AUDIO))).toBe(true);
  });

  it('finds an MPEG stream’s coded frames behind its tag', () => {
    const audio = mp3Audio();
    const bytes = concat(id3Tag([id3Frame('TIT2', ascii('a title'))]), audio);
    expect(spanBytes(bytes).equals(Buffer.from(audio))).toBe(true);
  });

  it('treats a Matroska container’s whole blob as the thing to keep still', () => {
    const bytes = concat(
      ebmlElement(MATROSKA_ID_EBML, filled(4, 0)),
      ebmlElement(MATROSKA_ID_SEGMENT, ebmlElement(MATROSKA_ID_CLUSTER, filled(32, 0x61)))
    );
    expect(spanBytes(bytes).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('refusing to locate content', () => {
  it('has no answer for bytes matching no registered container', () => {
    expect(contentSpans(filled(32, 0x01))).toBeUndefined();
  });

  it('has no answer for a registered format it cannot strip', () => {
    expect(contentSpans(gif([]))).toBeUndefined();
  });

  it('has no answer for a PNG carrying no image data at all', () => {
    const bytes = concat(
      png({ imageData: filled(8, 0x01) }).subarray(0, 8 + 25),
      pngChunk('IEND', new Uint8Array(0))
    );
    expect(contentSpans(bytes)).toBeUndefined();
  });

  it('has no answer for a FLAC stream whose block chain runs off the end', () => {
    const bytes = concat(
      FLAC_SIGNATURE,
      flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)),
      Uint8Array.from([FLAC_TYPE_PADDING, 0xff, 0xff, 0xff])
    );
    expect(contentSpans(bytes)).toBeUndefined();
  });

  it('has no answer for a blob whose block chain never ends', () => {
    const bytes = concat(FLAC_SIGNATURE, flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)));
    expect(contentSpans(bytes)).toBeUndefined();
  });
});

describe('hashing content', () => {
  it('agrees across two files whose image data is identical', () => {
    const one = png({ ancillary: [pngTextChunk('Software', 'a')], imageData: IMAGE_DATA });
    const two = png({ imageData: IMAGE_DATA });
    expect(contentHash(one)).toBe(contentHash(two));
  });

  it('disagrees the moment the image data differs by one byte', () => {
    const changed = filled(64, 0x5a);
    changed[7] = 0x5b;
    expect(contentHash(png({ imageData: IMAGE_DATA }))).not.toBe(
      contentHash(png({ imageData: changed }))
    );
  });

  it('has no hash where it has no content', () => {
    expect(contentHash(filled(32, 0x01))).toBeUndefined();
  });

  it('ignores an excluded span on both sides of a comparison', () => {
    const one = concat(ISO_FTYP, isoBox('mdat', concat(filled(8, 0x37), ascii('BANNER'))));
    const two = concat(ISO_FTYP, isoBox('mdat', concat(filled(8, 0x37), ascii('      '))));
    const at = Buffer.from(one).indexOf('BANNER');
    expect(contentHash(one)).not.toBe(contentHash(two));
    expect(contentHash(one, [{ start: at, end: at + 6 }])).toBe(
      contentHash(two, [{ start: at, end: at + 6 }])
    );
  });

  it('still sees a change beside an excluded span', () => {
    const one = concat(ISO_FTYP, isoBox('mdat', concat(filled(8, 0x37), ascii('BANNER'))));
    const two = concat(ISO_FTYP, isoBox('mdat', concat(filled(8, 0x38), ascii('BANNER'))));
    const at = Buffer.from(one).indexOf('BANNER');
    expect(contentHash(one, [{ start: at, end: at + 6 }])).not.toBe(
      contentHash(two, [{ start: at, end: at + 6 }])
    );
  });

  it('has no hash left when an exclusion covers a whole content run', () => {
    // Asserted as undefined on each side rather than compared to each other:
    // two undefined results are equal, so the comparison could not fail for the
    // property it was named for. Its neighbours pin the exclusion behaviour.
    const bytes = concat(ISO_FTYP, isoBox('mdat', filled(16, 0x37)));
    const spans = contentSpans(bytes) ?? [];
    expect(spans.length).toBeGreaterThan(0);
    expect(contentHash(bytes, spans)).toBeUndefined();
    expect(contentHash(bytes, [{ start: 0, end: bytes.length }])).toBeUndefined();
  });
});

describe('a container the walk cannot finish', () => {
  it('still reports the image data a truncated PNG did declare', () => {
    const whole = png({ imageData: IMAGE_DATA });
    expect(spanBytes(whole.subarray(0, -3)).equals(Buffer.from(IMAGE_DATA))).toBe(true);
  });
});

describe('a proof that would be computed over nothing', () => {
  it('has no answer for a container whose located spans hold no bytes', () => {
    // A real file cut back to its metadata: the chunk is present, its payload is
    // not. One span of zero length is not "some content", it is none.
    const bytes = concat(
      png({ imageData: filled(8, 0x01) }).subarray(0, 8 + 25),
      pngChunk('IDAT', new Uint8Array(0)),
      pngChunk('IEND', new Uint8Array(0))
    );
    expect(contentSpans(bytes)).toBeUndefined();
    expect(contentHash(bytes)).toBeUndefined();
  });

  it('has no hash once the exclusions cover every located byte', () => {
    const bytes = png({ imageData: IMAGE_DATA });
    const spans = contentSpans(bytes) ?? [];
    expect(contentHash(bytes, spans)).toBeUndefined();
  });

  it('has no hash once the exclusions cover every located byte from outside', () => {
    const bytes = png({ imageData: IMAGE_DATA });
    expect(contentHash(bytes, [{ start: 0, end: bytes.length }])).toBeUndefined();
  });

  it('still hashes when one located byte survives the exclusions', () => {
    const bytes = png({ imageData: IMAGE_DATA });
    const [span] = contentSpans(bytes) ?? [];
    expect(span).toBeDefined();
    expect(
      contentHash(bytes, [{ start: span?.start ?? 0, end: (span?.end ?? 1) - 1 }])
    ).toBeDefined();
  });

  it('measures located bytes rather than counting spans', () => {
    const empty = concat(
      png({ imageData: filled(8, 0x01) }).subarray(0, 8 + 25),
      pngChunk('IDAT', new Uint8Array(0)),
      pngChunk('IDAT', new Uint8Array(0)),
      pngChunk('IEND', new Uint8Array(0))
    );
    // Two spans, zero bytes: a count-based guard admits this and a byte-based one does not.
    expect(contentSpans(empty)).toBeUndefined();
  });
});

describe('totalSpanBytes', () => {
  it('adds the lengths of the spans it is given', () => {
    expect(
      totalSpanBytes([
        { start: 4, end: 10 },
        { start: 20, end: 21 },
      ])
    ).toBe(7);
  });

  it('is zero for no spans at all', () => {
    expect(totalSpanBytes([])).toBe(0);
  });
});

describe('overlappingBytes', () => {
  it('counts the part of one span a hole covers', () => {
    expect(overlappingBytes([{ start: 0, end: 10 }], [{ start: 2, end: 4 }])).toBe(2);
  });

  it('carries its walk past holes that end before a later span begins', () => {
    // Two located spans with the hole entirely inside the first: the walk has to
    // step the hole pointer forward rather than rescan it for the second span.
    expect(
      overlappingBytes(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        [{ start: 2, end: 4 }]
      )
    ).toBe(2);
  });

  it('steps past a hole that outran one span and ended before the next', () => {
    // The hole runs off the end of the first span, so the walk stops inside it;
    // the second span then has to skip it rather than re-read it.
    expect(
      overlappingBytes(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        [{ start: 5, end: 15 }]
      )
    ).toBe(5);
  });

  it('counts a hole spanning two located spans once per span', () => {
    expect(
      overlappingBytes(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        [{ start: 5, end: 25 }]
      )
    ).toBe(10);
  });

  it('folds overlapping holes together rather than counting them twice', () => {
    expect(
      overlappingBytes(
        [{ start: 0, end: 10 }],
        [
          { start: 2, end: 6 },
          { start: 4, end: 8 },
        ]
      )
    ).toBe(6);
  });

  it('keeps counting into a span that begins where the previous one ended', () => {
    // Adjacent located spans with a hole straddling the join: dropping the hole
    // after the first span would stop counting its share of the second.
    expect(
      overlappingBytes(
        [
          { start: 0, end: 10 },
          { start: 10, end: 20 },
        ],
        [{ start: 5, end: 11 }]
      )
    ).toBe(6);
  });

  it('counts nothing when the holes miss every span', () => {
    expect(overlappingBytes([{ start: 0, end: 10 }], [{ start: 40, end: 50 }])).toBe(0);
  });
});

describe('span merging at its own edges', () => {
  it('folds two spans that exactly touch into one', () => {
    expect(
      mergeSpans([
        { start: 0, end: 4 },
        { start: 4, end: 8 },
      ])
    ).toEqual([{ start: 0, end: 8 }]);
  });

  it('leaves two spans separated by a single byte apart', () => {
    // Merging across one byte would put that byte inside an overwrite that
    // nothing reported — and the content proof cannot see it, because the
    // excluded set is exactly what the remedy rewrote.
    expect(
      mergeSpans([
        { start: 0, end: 4 },
        { start: 5, end: 9 },
      ])
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
  });

  it('folds a span wholly inside another', () => {
    expect(
      mergeSpans([
        { start: 0, end: 10 },
        { start: 2, end: 4 },
      ])
    ).toEqual([{ start: 0, end: 10 }]);
  });
});

describe('the subtraction walk at its own edges', () => {
  it('keeps a hole that starts exactly where a span ends out of it', () => {
    expect(overlappingBytes([{ start: 0, end: 10 }], [{ start: 10, end: 20 }])).toBe(0);
  });

  it('counts a hole that starts one byte before a span ends', () => {
    expect(overlappingBytes([{ start: 0, end: 10 }], [{ start: 9, end: 20 }])).toBe(1);
  });

  it('counts a hole that starts one byte into a span', () => {
    // The single byte in front of the hole is the piece a comparison one step
    // wide stops emitting.
    expect(overlappingBytes([{ start: 0, end: 10 }], [{ start: 1, end: 20 }])).toBe(9);
  });

  it('counts a hole that starts exactly where a span starts', () => {
    expect(overlappingBytes([{ start: 10, end: 20 }], [{ start: 10, end: 12 }])).toBe(2);
  });

  it('keeps a hole that ends exactly where a span starts out of it', () => {
    expect(overlappingBytes([{ start: 10, end: 20 }], [{ start: 5, end: 10 }])).toBe(0);
  });

  it('counts a hole ending exactly where a span ends', () => {
    expect(overlappingBytes([{ start: 0, end: 10 }], [{ start: 6, end: 10 }])).toBe(4);
  });

  it('counts a hole ending one byte past a span', () => {
    expect(overlappingBytes([{ start: 0, end: 10 }], [{ start: 6, end: 11 }])).toBe(4);
  });
});

describe('locating content at the end of a blob', () => {
  it('finds image data whose chunk ends exactly at the blob end', () => {
    const bytes = concat(
      png({ imageData: filled(8, 0x01) }).subarray(0, 8 + 25),
      pngChunk('IDAT', filled(16, 0x5a))
    );
    expect(spanBytes(bytes).equals(Buffer.from(filled(16, 0x5a)))).toBe(true);
  });

  it('refuses image data whose chunk runs one byte past the blob end', () => {
    const whole = concat(
      png({ imageData: filled(8, 0x01) }).subarray(0, 8 + 25),
      pngChunk('IDAT', filled(16, 0x5a))
    );
    expect(contentSpans(whole.subarray(0, -1))).toBeUndefined();
  });

  it('ignores a chunk header that would run past the blob end', () => {
    const whole = concat(
      png({ imageData: filled(8, 0x01) }).subarray(0, 8 + 25),
      pngChunk('IDAT', filled(16, 0x5a))
    );
    // Seven spare bytes: one short of a chunk header, so the walk must not read
    // one there.
    expect(spanBytes(concat(whole, filled(7, 0x00))).equals(Buffer.from(filled(16, 0x5a)))).toBe(
      true
    );
  });

  it('refuses a FLAC whose last block body ends exactly at the blob end', () => {
    const bytes = concat(
      FLAC_SIGNATURE,
      flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)),
      flacBlock(FLAC_TYPE_PADDING, filled(8, 0), true)
    );
    // The audio is what this locates, and there is none.
    expect(contentSpans(bytes)).toBeUndefined();
  });

  it('finds a single audio byte behind the last block', () => {
    const bytes = concat(
      FLAC_SIGNATURE,
      flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)),
      flacBlock(FLAC_TYPE_PADDING, filled(8, 0), true),
      Uint8Array.from([0xff])
    );
    expect(spanBytes(bytes).equals(Buffer.from([0xff]))).toBe(true);
  });

  it('refuses a FLAC whose last block header runs one byte past the blob end', () => {
    const bytes = concat(
      FLAC_SIGNATURE,
      flacBlock(FLAC_TYPE_STREAMINFO, filled(34, 0)),
      Uint8Array.from([FLAC_TYPE_PADDING, 0, 0])
    );
    expect(contentSpans(bytes)).toBeUndefined();
  });
});
