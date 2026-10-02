import { describe, expect, it } from 'vitest';

import { gateResult } from './gate.js';
import { reportMarkdown, verifyReport } from './report.js';

const PASSED = gateResult('purity', [], ['3 probe frames compared']);
const FAILED = gateResult(
  'frames',
  [{ filmId: 'film', rule: 'seam', at: 'frame 96', detail: 'too bright' }],
  ['1 cut judged']
);

describe('verifyReport', () => {
  it('passes when every gate passed', () => {
    expect(verifyReport('film', [PASSED]).passed).toBe(true);
  });

  it('fails when any gate failed', () => {
    expect(verifyReport('film', [PASSED, FAILED]).passed).toBe(false);
  });

  it('keeps every gate under machine-verified', () => {
    expect(verifyReport('film', [PASSED, FAILED]).machineVerified.map(({ gate }) => gate)).toEqual([
      'purity',
      'frames',
    ]);
  });

  it('names the contact sheet under checked by looking', () => {
    expect(verifyReport('film', [PASSED]).checkedByLooking).toEqual([
      'out/sheet.png: every probe frame, labelled; a person looks at it',
    ]);
  });

  it('says the mix has not been listened to under not verified', () => {
    expect(verifyReport('film', [PASSED]).notVerified).toEqual([
      'the mix has not been listened to',
    ]);
  });
});

describe('reportMarkdown', () => {
  const markdown = reportMarkdown(verifyReport('film', [PASSED, FAILED]));

  it('titles the report with the film and its verdict', () => {
    expect(markdown.split('\n')[0]).toBe('# film: verify failed');
  });

  it('lists a passing gate with what it measured', () => {
    expect(markdown).toContain('- **purity**: pass\n  - 3 probe frames compared');
  });

  it('lists a failing gate with each failure line', () => {
    expect(markdown).toContain(
      '- **frames**: FAIL\n  - film: seam: frame 96: too bright\n  - 1 cut judged'
    );
  });

  it('holds the three sections in order', () => {
    const headings = markdown.split('\n').filter((line) => line.startsWith('## '));

    expect(headings).toEqual(['## Machine-verified', '## Checked by looking', '## Not verified']);
  });

  it('titles a passing report as passed', () => {
    expect(reportMarkdown(verifyReport('film', [PASSED])).split('\n')[0]).toBe(
      '# film: verify passed'
    );
  });

  it('ends with a newline', () => {
    expect(markdown.endsWith('\n')).toBe(true);
  });
});
