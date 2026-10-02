import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatUsage,
  isHelpRequest,
  parseCommandLine,
  readCommandLine,
  readCommandLineOrRefuse,
  type CommandSpec,
} from './command-line';

const RECLAIM = {
  command: 'pnpm dev:clean',
  summary: 'Reclaims this checkout of everything a finished run left behind.',
  flags: [
    { flag: '--all', kind: 'boolean', summary: "Include this checkout's own live runs." },
    { flag: '--dry-run', kind: 'boolean', summary: 'Classify everything; change nothing.' },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

const VALUED = {
  command: 'pnpm ensure-stack',
  summary: 'Brings the local stack up.',
  flags: [
    { flag: '--wipe', kind: 'boolean', summary: 'Recreate the data plane from empty.' },
    { flag: '--env-mode', kind: 'value', placeholder: '<mode>', summary: 'Which stack to build.' },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

const LISTED = {
  command: 'pnpm lint:check',
  summary: 'Reports which lint rules cover which files.',
  flags: [{ flag: '--rule', kind: 'list', placeholder: '<id>', summary: 'Narrow to one rule.' }],
  positionals: { kind: 'many', placeholder: '<path>', summary: 'Paths to read.' },
} as const satisfies CommandSpec;

describe('parseCommandLine', () => {
  it('rejects an argument the spec does not name', () => {
    expect(() => parseCommandLine(RECLAIM, ['--purge'])).toThrow(/--purge/);
  });

  it('rejects a misspelt spelling of a flag the spec does name', () => {
    expect(() => parseCommandLine(RECLAIM, ['--dry-runn'])).toThrow(/--dry-runn/);
  });

  it('names the command in the refusal', () => {
    expect(() => parseCommandLine(RECLAIM, ['--purge'])).toThrow(/pnpm dev:clean/);
  });

  it('reads --help as a request for usage', () => {
    expect(parseCommandLine(RECLAIM, ['--help']).kind).toBe('help');
  });

  it('reads -h as a request for usage', () => {
    expect(parseCommandLine(RECLAIM, ['-h']).kind).toBe('help');
  });

  it('answers a help request even when a real flag stands beside it', () => {
    expect(parseCommandLine(RECLAIM, ['--all', '--help']).kind).toBe('help');
  });

  it('answers a help request rather than refusing the unknown argument beside it', () => {
    expect(parseCommandLine(RECLAIM, ['--purge', '--help']).kind).toBe('help');
  });

  it('carries the usage text on the help outcome', () => {
    const parsed = parseCommandLine(RECLAIM, ['--help']);
    expect(parsed.kind === 'help' && parsed.usage).toBe(formatUsage(RECLAIM));
  });

  it('reads a boolean flag that is present as true', () => {
    const parsed = parseCommandLine(RECLAIM, ['--all']);
    expect(parsed.kind === 'run' && parsed.flags['--all']).toBe(true);
  });

  it('reads a boolean flag that is absent as false', () => {
    const parsed = parseCommandLine(RECLAIM, ['--all']);
    expect(parsed.kind === 'run' && parsed.flags['--dry-run']).toBe(false);
  });

  it('reads a value flag written as two tokens', () => {
    const parsed = parseCommandLine(VALUED, ['--env-mode', 'e2e']);
    expect(parsed.kind === 'run' && parsed.flags['--env-mode']).toBe('e2e');
  });

  it('reads a value flag written with an equals sign', () => {
    const parsed = parseCommandLine(VALUED, ['--env-mode=e2e']);
    expect(parsed.kind === 'run' && parsed.flags['--env-mode']).toBe('e2e');
  });

  it('reads an absent value flag as undefined', () => {
    const parsed = parseCommandLine(VALUED, ['--wipe']);
    expect(parsed.kind === 'run' && parsed.flags['--env-mode']).toBeUndefined();
  });

  it('rejects a value flag left without a value', () => {
    expect(() => parseCommandLine(VALUED, ['--env-mode'])).toThrow(/--env-mode/);
  });

  it('rejects a value flag whose value slot holds the next flag', () => {
    expect(() => parseCommandLine(VALUED, ['--env-mode', '--wipe'])).toThrow(/--env-mode/);
  });

  it('rejects a value handed to a boolean flag', () => {
    expect(() => parseCommandLine(VALUED, ['--wipe=yes'])).toThrow(/--wipe/);
  });

  it('collects every occurrence of a list flag', () => {
    const parsed = parseCommandLine(LISTED, ['--rule=a', '--rule', 'b']);
    expect(parsed.kind === 'run' && parsed.flags['--rule']).toEqual(['a', 'b']);
  });

  it('reads an absent list flag as empty', () => {
    const parsed = parseCommandLine(LISTED, []);
    expect(parsed.kind === 'run' && parsed.flags['--rule']).toEqual([]);
  });

  it('keeps a positional the spec admits', () => {
    const parsed = parseCommandLine(LISTED, ['src/index.ts']);
    expect(parsed.kind === 'run' && parsed.positionals).toEqual(['src/index.ts']);
  });

  it('rejects a positional the spec admits none of, naming it', () => {
    expect(() => parseCommandLine(RECLAIM, ['everything'])).toThrow(/everything/);
  });

  it('rejects a single-dash argument the spec does not name', () => {
    expect(() => parseCommandLine(RECLAIM, ['-a'])).toThrow(/-a/);
  });
});

describe('formatUsage', () => {
  it('names the command it belongs to', () => {
    expect(formatUsage(RECLAIM)).toContain('pnpm dev:clean');
  });

  it('carries the summary of what the command does', () => {
    expect(formatUsage(RECLAIM)).toContain(RECLAIM.summary);
  });

  it('lists every flag the spec names, with what it does', () => {
    const usage = formatUsage(RECLAIM);
    expect(usage).toContain('--all');
    expect(usage).toContain("Include this checkout's own live runs.");
  });

  it('shows the value placeholder of a flag that takes one', () => {
    expect(formatUsage(VALUED)).toContain('--env-mode <mode>');
  });

  it('lists --help itself, which no spec has to declare', () => {
    expect(formatUsage(RECLAIM)).toContain('--help');
  });

  it('shows the positional a command admits', () => {
    expect(formatUsage(LISTED)).toContain('<path>');
  });
});

describe('readCommandLine', () => {
  it('answers a help request with nothing to run', () => {
    expect(readCommandLine(RECLAIM, ['--help'], () => {})).toBeNull();
  });

  it('writes the usage text out on a help request', () => {
    const written: string[] = [];
    readCommandLine(RECLAIM, ['--help'], (text) => written.push(text));
    expect(written.join('')).toContain(formatUsage(RECLAIM));
  });

  it('hands back the parse when the line runs', () => {
    const parsed = readCommandLine(RECLAIM, ['--all'], () => {});
    expect(parsed?.flags['--all']).toBe(true);
  });

  it('writes nothing when the line runs', () => {
    const write = vi.fn();
    readCommandLine(RECLAIM, ['--all'], write);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses an unrecognised argument rather than running', () => {
    expect(() => readCommandLine(RECLAIM, ['--purge'], () => {})).toThrow(/--purge/);
  });

  it('writes usage to standard output when given no writer', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      readCommandLine(RECLAIM, ['--help']);
      expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('pnpm dev:clean');
    } finally {
      write.mockRestore();
    }
  });
});

describe('readCommandLineOrRefuse', () => {
  let exitCode: typeof process.exitCode;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    exitCode = process.exitCode;
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = exitCode;
  });

  it('hands back the parse when the line runs', () => {
    expect(readCommandLineOrRefuse(RECLAIM, ['--all'])?.flags['--all']).toBe(true);
  });

  it('leaves the exit code alone when the line runs', () => {
    process.exitCode = 0;
    readCommandLineOrRefuse(RECLAIM, ['--all']);
    expect(process.exitCode).toBe(0);
  });

  it('answers a help request with nothing to run', () => {
    expect(readCommandLineOrRefuse(RECLAIM, ['--help'])).toBeNull();
  });

  it('writes the usage out on a help request', () => {
    readCommandLineOrRefuse(RECLAIM, ['--help']);
    expect(out.join('')).toContain(formatUsage(RECLAIM));
  });

  it('leaves the exit code alone on a help request', () => {
    process.exitCode = 0;
    readCommandLineOrRefuse(RECLAIM, ['--help']);
    expect(process.exitCode).toBe(0);
  });

  it('answers an unrecognised argument with nothing to run rather than throwing', () => {
    expect(readCommandLineOrRefuse(RECLAIM, ['--purge'])).toBeNull();
  });

  it('fails the exit code on an unrecognised argument', () => {
    process.exitCode = 0;
    readCommandLineOrRefuse(RECLAIM, ['--purge']);
    expect(process.exitCode).toBe(1);
  });

  it('writes the refusal, naming the argument', () => {
    readCommandLineOrRefuse(RECLAIM, ['--purge']);
    expect(err.join('')).toContain('--purge');
  });
});

describe('isHelpRequest', () => {
  it('reads --help as one', () => {
    expect(isHelpRequest(['--help'])).toBe(true);
  });

  it('reads -h as one', () => {
    expect(isHelpRequest(['-h'])).toBe(true);
  });

  it('reads a line carrying neither as no request', () => {
    expect(isHelpRequest(['--all'])).toBe(false);
  });

  it('reads a help request standing beside an argument no spec would take', () => {
    expect(isHelpRequest(['--purge', '--help'])).toBe(true);
  });
});
