import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A killed process is not an error the tool can catch — it is the absence of
 * further execution — so what a test can reproduce is its effect on the file
 * system: some prefix of the bytes landed and nothing after it ran. The hook
 * below reproduces exactly that, and records the paths the write was aimed at.
 */
const writes = vi.hoisted(() => ({ interruptAfter: -1, targets: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    writeFileSync: (target: string, data: Uint8Array): void => {
      writes.targets.push(target);
      if (writes.interruptAfter < 0) {
        real.writeFileSync(target, data);
        return;
      }
      real.writeFileSync(target, data.subarray(0, writes.interruptAfter));
      throw new Error('the write did not finish');
    },
  };
});

import { TEST_DAY_START } from '@hushbox/shared/test-time';

import { CLEARED_STATUSES, formatStripReport, runBinaryPrivacyFix } from './fix-binary-privacy.js';
import { scanBinaryBlob } from './lib/privacy/binary/scan.js';
import {
  ISO_FTYP,
  ascii,
  concat,
  filled,
  gif,
  gifComment,
  isoBox,
  isoZeroSizedBox,
  png,
  pngTextChunk,
} from './lib/__test-fixtures-binary-strip__/media.js';

const IMAGE_DATA = filled(64, 0x5a);

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'hb-strip-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function place(name: string, bytes: Uint8Array): string {
  const at = path.join(workspace, name);
  writeFileSync(at, bytes);
  return at;
}

const DIRTY_PNG = png({
  ancillary: [pngTextChunk('Software', 'Matplotlib 3.9.0')],
  imageData: IMAGE_DATA,
});

describe('the fix command', () => {
  it('rewrites a file it could strip', () => {
    const at = place('a.png', DIRTY_PNG);
    expect(runBinaryPrivacyFix([at]).code).toBe(0);
    expect(scanBinaryBlob('a.png', readFileSync(at))).toEqual([]);
  });

  it('leaves a file the detector reports nothing about byte-identical', () => {
    const clean = png({ imageData: IMAGE_DATA });
    const at = place('a.png', clean);
    expect(runBinaryPrivacyFix([at]).code).toBe(0);
    expect(readFileSync(at).equals(Buffer.from(clean))).toBe(true);
  });

  it('fails and writes nothing when it has to refuse', () => {
    const damaged = png({ imageData: IMAGE_DATA, trailing: filled(16, 0x99) });
    const at = place('a.png', damaged);
    expect(runBinaryPrivacyFix([at]).code).toBe(1);
    expect(readFileSync(at).equals(Buffer.from(damaged))).toBe(true);
  });

  it('fails and writes nothing for a format it has no lossless remedy for', () => {
    const dirty = gif([gifComment('Made with ImageMagick 7')]);
    const at = place('a.gif', dirty);
    const result = runBinaryPrivacyFix([at]);
    expect(result.code).toBe(1);
    expect(readFileSync(at).equals(Buffer.from(dirty))).toBe(true);
    expect(result.report).toContain('unsupported');
  });

  it('strips the files it can even when a sibling in the same run refuses', () => {
    const good = place('good.png', DIRTY_PNG);
    const bad = place('bad.png', png({ imageData: IMAGE_DATA, trailing: filled(8, 0x99) }));
    expect(runBinaryPrivacyFix([good, bad]).code).toBe(1);
    expect(scanBinaryBlob('good.png', readFileSync(good))).toEqual([]);
    expect(scanBinaryBlob('bad.png', readFileSync(bad)).length).toBeGreaterThan(0);
  });

  it('reports a path it cannot read rather than throwing', () => {
    const result = runBinaryPrivacyFix([path.join(workspace, 'absent.png')]);
    expect(result.code).toBe(1);
    expect(result.report).toContain('unreadable');
  });

  it('asks for paths when it is given none', () => {
    const result = runBinaryPrivacyFix([]);
    expect(result.code).toBe(1);
    expect(result.report).toContain('path');
  });

  it('names the true format of a file wearing the wrong extension', () => {
    const at = place('cover.jpg', DIRTY_PNG);
    const result = runBinaryPrivacyFix([at]);
    expect(result.report).toContain('PNG image');
  });

  it('renders a path relative to the working directory rather than absolutely', () => {
    const at = place('a.png', DIRTY_PNG);
    const line =
      runBinaryPrivacyFix([at])
        .report.split('\n')
        .find((candidate) => candidate.includes('a.png')) ?? '';
    const shown = line.trim().split(/\s+/u)[1] ?? '';
    expect(shown.endsWith('a.png')).toBe(true);
    expect(path.isAbsolute(shown)).toBe(false);
  });

  it('renders a path inside the working directory in full', () => {
    const inside = path.join('scripts', 'lib', 'nothing-here.png');
    expect(runBinaryPrivacyFix([inside]).report).toContain(inside.replaceAll('\\', '/'));
  });
});

describe('the fix report', () => {
  it('says nothing needed doing when every file was already clean', () => {
    expect(formatStripReport([])).toContain('no files');
  });

  it('records the content hash it proved unchanged', () => {
    const at = place('a.png', DIRTY_PNG);
    const result = runBinaryPrivacyFix([at]);
    expect(result.report).toMatch(/content unchanged \(sha256 [0-9a-f]{12}\)/);
  });

  it('counts the edits it applied', () => {
    const at = place('a.png', DIRTY_PNG);
    expect(runBinaryPrivacyFix([at]).report).toContain('1 edit');
  });

  it('carries the reason a refusal gives', () => {
    const at = place('a.bin', concat(ascii('nothing'), filled(64, 0x01)));
    const result = runBinaryPrivacyFix([at]);
    expect(result.code).toBe(1);
    expect(result.report).toContain('registered container');
  });
});

describe('paths the command cannot act on', () => {
  it('reports a directory rather than reading it', () => {
    const result = runBinaryPrivacyFix([workspace]);
    expect(result.code).toBe(1);
    expect(result.report).toContain('not a regular file');
  });

  it('counts more than one edit in the plural', () => {
    const at = place(
      'two.png',
      png({
        ancillary: [pngTextChunk('Software', 'Matplotlib 3.9.0'), pngTextChunk('Comment', 'made')],
        imageData: IMAGE_DATA,
      })
    );
    expect(runBinaryPrivacyFix([at]).report).toContain('2 edits');
  });
});

describe('files the command decided not to touch', () => {
  it('does not open a refused file for writing at all', () => {
    const damaged = png({ imageData: IMAGE_DATA, trailing: filled(16, 0x99) });
    const at = place('a.png', damaged);
    // Byte equality cannot see a rewrite of identical content, so the file's own
    // modification time is what says whether it was opened.
    utimesSync(at, TEST_DAY_START / 1000, TEST_DAY_START / 1000);
    const before = statSync(at).mtimeMs;
    expect(runBinaryPrivacyFix([at]).code).toBe(1);
    expect(statSync(at).mtimeMs).toBe(before);
  });

  it('does open a file it stripped', () => {
    const at = place('a.png', DIRTY_PNG);
    utimesSync(at, TEST_DAY_START / 1000, TEST_DAY_START / 1000);
    const before = statSync(at).mtimeMs;
    expect(runBinaryPrivacyFix([at]).code).toBe(0);
    expect(statSync(at).mtimeMs).not.toBe(before);
  });
});

describe('a strip that cannot prove itself', () => {
  it('reports the file and leaves the rest of the batch alone', () => {
    const swallowed = concat(
      ISO_FTYP,
      isoZeroSizedBox(
        'uuid',
        concat(filled(16, 0x2b), ascii('c2pa'), isoBox('mdat', filled(48, 0x37)))
      )
    );
    const bad = place('swallowed.mp4', swallowed);
    const good = place('good.png', DIRTY_PNG);
    const result = runBinaryPrivacyFix([bad, good]);
    expect(result.code).toBe(1);
    expect(result.report).toContain('content bytes');
    expect(readFileSync(bad).equals(Buffer.from(swallowed))).toBe(true);
    expect(scanBinaryBlob('good.png', readFileSync(good))).toEqual([]);
  });
});

describe('what counts as needing nothing further', () => {
  it('exits non-zero for a file whose only finding no byte edit can fix', () => {
    const at = place('cover.jpg', png({ imageData: IMAGE_DATA }));
    const result = runBinaryPrivacyFix([at]);
    expect(result.code).toBe(1);
    expect(result.report).toContain('incomplete');
  });

  it('clears a strip and an untouched clean file, and nothing else', () => {
    // Imported rather than restated: a second copy of this table would drift,
    // and the misnamed-extension contract rests entirely on what is not in it.
    expect([...CLEARED_STATUSES].toSorted((left, right) => left.localeCompare(right))).toEqual([
      'clean',
      'stripped',
    ]);
  });
});

describe('what a report may say about where a file lives', () => {
  it('renders a target outside the working directory without its host layout', () => {
    const at = place('a.png', DIRTY_PNG);
    const { report } = runBinaryPrivacyFix([at]);
    const segments = path
      .dirname(at)
      .split(path.sep)
      .filter((segment) => segment.length >= 4);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) expect(report).not.toContain(segment);
    expect(report).toContain('a.png');
  });

  it("counts the working directory's own parent as a target outside it", () => {
    const inner = path.join(workspace, 'inner');
    mkdirSync(inner);
    vi.spyOn(process, 'cwd').mockReturnValue(inner);
    const line =
      runBinaryPrivacyFix([workspace])
        .report.split('\n')
        .find((candidate) => candidate.includes('unreadable')) ?? '';
    expect(line.trim().split(/\s+/u)[1]).toBe(path.basename(workspace));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('replacing a file it could strip', () => {
  afterEach(() => {
    writes.interruptAfter = -1;
    writes.targets = [];
  });

  /**
   * The command lands its replacement through `scripts/lib/staged-write.ts`,
   * and this package's setup file
   * (`scripts/lib/vitest/run-claim-restored.setup.ts`) reaches that module
   * through the claims registry — so it is bound to the real `node:fs` before
   * the mock at the head of this file registers, and the hook the cases below
   * watch the write through never sees the write. Re-importing the command
   * into a fresh module graph is what puts the hook back in its path, and it
   * holds however the setup file's own imports move.
   */
  async function freshlyImportedFix(): Promise<typeof runBinaryPrivacyFix> {
    vi.resetModules();
    const fresh = await import('./fix-binary-privacy.js');
    return fresh.runBinaryPrivacyFix;
  }

  it('never writes through the path it is replacing', async () => {
    const replace = await freshlyImportedFix();
    const at = place('a.png', DIRTY_PNG);
    writes.targets = [];
    expect(replace([at]).code).toBe(0);
    expect(writes.targets).not.toContain(at);
    expect(writes.targets.length).toBeGreaterThan(0);
  });

  it('leaves the original whole when the write does not finish', async () => {
    const replace = await freshlyImportedFix();
    const at = place('a.png', DIRTY_PNG);
    writes.interruptAfter = 3;
    expect(() => replace([at])).toThrow();
    expect(readFileSync(at).equals(Buffer.from(DIRTY_PNG))).toBe(true);
  });

  it('leaves no half-written sibling behind when the write does not finish', async () => {
    const replace = await freshlyImportedFix();
    const at = place('a.png', DIRTY_PNG);
    writes.interruptAfter = 3;
    expect(() => replace([at])).toThrow();
    expect(readdirSync(path.dirname(at))).toEqual(['a.png']);
  });

  it('carries the target file mode across the replacement', () => {
    const at = place('a.png', DIRTY_PNG);
    chmodSync(at, 0o640);
    const before = statSync(at).mode;
    expect(runBinaryPrivacyFix([at]).code).toBe(0);
    expect(statSync(at).mode).toBe(before);
  });
});
