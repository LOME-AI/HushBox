import { describe, expect, it, vi } from 'vitest';

import { RAW_DIR_ENV, REPORT_ENV, scanForOffsetDivergence } from './coverage-offset-reporter.js';

const divergentDirectory = {
  readdir: (): readonly string[] => ['coverage-0.json', 'coverage-1.json'],
  readFile: (file: string): string =>
    file.endsWith('coverage-0.json')
      ? '{"result":[{"url":"file:///p/a.test.ts","startOffset":209},{"url":"file:///p/s.ts","startOffset":209}]}'
      : '{"result":[{"url":"file:///p/b.test.ts","startOffset":209},{"url":"file:///p/s.ts","startOffset":0}]}',
};

describe('scanForOffsetDivergence', () => {
  it('writes the divergence it found to the report path', () => {
    const writeFile = vi.fn();
    scanForOffsetDivergence(
      { [RAW_DIR_ENV]: '/cov/.tmp', [REPORT_ENV]: '/out/report.json' },
      { ...divergentDirectory, writeFile }
    );

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [file, contents] = writeFile.mock.calls[0] as [string, string];
    expect(file).toBe('/out/report.json');
    expect(JSON.parse(contents)).toEqual([
      {
        url: 'file:///p/s.ts',
        offsets: [
          { startOffset: 0, testFiles: ['file:///p/b.test.ts'] },
          { startOffset: 209, testFiles: ['file:///p/a.test.ts'] },
        ],
      },
    ]);
  });

  it('writes an empty report on a clean run, so a missing file means the scan never ran', () => {
    const writeFile = vi.fn();
    scanForOffsetDivergence(
      { [RAW_DIR_ENV]: '/cov/.tmp', [REPORT_ENV]: '/out/report.json' },
      {
        readdir: () => ['coverage-0.json'],
        readFile: () => '{"result":[{"url":"file:///p/a.test.ts","startOffset":209}]}',
        writeFile,
      }
    );

    expect(writeFile).toHaveBeenCalledWith('/out/report.json', '[]');
  });

  it('does nothing when the runner did not ask for a scan', () => {
    const writeFile = vi.fn();
    const readdir = vi.fn(() => []);
    scanForOffsetDivergence({}, { readdir, readFile: () => '', writeFile });

    expect(readdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does nothing when only one of the two variables is set', () => {
    const writeFile = vi.fn();
    scanForOffsetDivergence(
      { [RAW_DIR_ENV]: '/cov/.tmp' },
      { readdir: () => [], readFile: () => '', writeFile }
    );

    expect(writeFile).not.toHaveBeenCalled();
  });

  it('never throws out of the reporter hook, even when the report cannot be written', () => {
    // A reporter that throws takes down a run whose tests all passed; this gate
    // must be able to fail a run only through its findings, never by crashing.
    expect(() => {
      scanForOffsetDivergence(
        { [RAW_DIR_ENV]: '/cov/.tmp', [REPORT_ENV]: '/out/report.json' },
        {
          ...divergentDirectory,
          writeFile: () => {
            throw new Error('EACCES');
          },
        }
      );
    }).not.toThrow();
  });
});
