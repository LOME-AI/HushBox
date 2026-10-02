import type { GateResult } from './gate.js';

/** What `pnpm films verify` writes: what a machine verified, what a person checks by looking, and what nobody has. */
export interface VerifyReport {
  filmId: string;
  passed: boolean;
  machineVerified: GateResult[];
  checkedByLooking: string[];
  notVerified: string[];
}

/** The report of a film's gates. */
export function verifyReport(filmId: string, results: readonly GateResult[]): VerifyReport {
  return {
    filmId,
    passed: results.every(({ passed }) => passed),
    machineVerified: [...results],
    checkedByLooking: ['out/sheet.png: every probe frame, labelled; a person looks at it'],
    notVerified: ['the mix has not been listened to'],
  };
}

function gateLines({ gate, passed, failures, measured }: GateResult): string[] {
  return [
    `- **${gate}**: ${passed ? 'pass' : 'FAIL'}`,
    ...[...failures, ...measured].map((line) => `  - ${line}`),
  ];
}

/** The report as `out/report.md`. */
export function reportMarkdown(report: VerifyReport): string {
  return [
    `# ${report.filmId}: verify ${report.passed ? 'passed' : 'failed'}`,
    '',
    '## Machine-verified',
    '',
    ...report.machineVerified.flatMap((result) => gateLines(result)),
    '',
    '## Checked by looking',
    '',
    ...report.checkedByLooking.map((line) => `- ${line}`),
    '',
    '## Not verified',
    '',
    ...report.notVerified.map((line) => `- ${line}`),
    '',
  ].join('\n');
}
