import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_LINE, main, SUBCOMMAND_LINES } from './cli.js';

const EMPTY = `# Status — run\n\n📊 start\n\n| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |\n| --- | --- | --- | --- | --- |\n| 0 | none | none | 0 | 0 (0 blocking) |\n\n## Open\n\n## Answered\n`;

let runDir: string;
let out: string[];

const log = (line: string): void => {
  out.push(line);
};

function status(): string {
  return readFileSync(path.join(runDir, 'status.md'), 'utf8');
}

async function run(...argv: string[]): Promise<void> {
  const [verb = '', ...rest] = argv;
  await main([verb, '--run', runDir, ...rest], log);
}

const PROBLEM = [
  '- Found — late lock at settle.ts:40.',
  '- Today — two runs read one balance and both charge it.',
  '- After — the row is held before the charge, so the second run waits.',
  '- Breaks — nothing else reads that row.',
].join('\n');

/** A Problem that weighs its options in a table, so the card takes no Alternatives field. */
const TABLE_PROBLEM = [
  PROBLEM,
  '',
  '| option | cost | why not |',
  '| --- | --- | --- |',
  '| lock first | one wait | — |',
  '| serialize every run | a queue | too slow |',
].join('\n');

// A bulleted body reaches a flag inline or as `@<path>`: the shared argv reader
// refuses a separate token beginning with a dash, which every bullet does.
const OPEN_ARGS = [
  'open',
  '--title',
  'should the lock move first?',
  '--blocks',
  'T03',
  `--problem=${PROBLEM}`,
  '--recommendation',
  'lock first',
  '--decision',
  'Move the lock.',
  '--alternatives',
  'lock after',
];

beforeEach(() => {
  runDir = mkdtempSync(path.join(tmpdir(), 'cards-cli-'));
  writeFileSync(path.join(runDir, 'status.md'), EMPTY);
  writeFileSync(path.join(runDir, 'ledger.md'), '# Ledger\n');
  out = [];
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('grammar', () => {
  it('declares one spec per verb, each taking --run', () => {
    expect(Object.keys(SUBCOMMAND_LINES).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'answer',
      'chart',
      'check',
      'create',
      'edit',
      'list',
      'open',
      'pending',
      'reopen',
      'show',
      'state',
      'supersede',
      'title',
      'withdraw',
    ]);
    for (const spec of Object.values(SUBCOMMAND_LINES)) {
      expect(spec.flags.some((flag) => flag.flag === '--run')).toBe(true);
    }
    expect(COMMAND_LINE.command).toBe('pnpm cards');
  });

  it('refuses a missing verb and an unknown verb', async () => {
    await expect(main([], log)).rejects.toThrow(/Missing command/);
    await expect(main(['dance'], log)).rejects.toThrow(/dance/);
  });

  it('prints usage for --help at the top level and per verb', async () => {
    await main(['--help'], log);
    await main(['open', '--help'], log);
    expect(out.join('\n')).toContain('pnpm cards open');
  });

  it('refuses a verb without --run', async () => {
    await expect(main(['list'], log)).rejects.toThrow(/--run/);
  });

  it('names withdraw in the top-level usage', async () => {
    await main(['--help'], log);
    expect(out.join('\n')).toContain('withdraw');
  });

  it('hints the attached form a field value opening with a dash needs', async () => {
    await main(['open', '--help'], log);
    expect(out.join('\n')).toMatch(
      /--problem <text>.*a value opening with a dash needs --flag=value/
    );
  });

  it('names the removal form in the edit usage', async () => {
    await main(['edit', '--help'], log);
    expect(out.join('\n')).toMatch(/--remove\s+Delete the field/);
  });

  it('states the rule a removal is refused under, rather than the fields it is refused for', async () => {
    await main(['edit', '--help'], log);
    const removal =
      out
        .join('\n')
        .split('\n')
        .find((line) => line.trim().startsWith('--remove')) ?? '';
    expect(removal).toMatch(
      /refused unless the card carries it, edit writes it, and the card still holds its shape without it/
    );
    expect(removal).not.toMatch(/Problem|Recommendation|Decision|Alternatives/);
  });

  it('summarises the findings state without naming a field the card may not carry', async () => {
    await main(['state', '--help'], log);
    expect(out.join('\n')).toContain('findings');
    expect(out.join('\n')).not.toContain('Alternatives');
  });
});

describe('open, list, show', () => {
  it('opens a drafting card and prints its id', async () => {
    await run(...OPEN_ARGS);
    expect(out).toEqual(['Q1']);
    expect(status()).toContain('## 📝 Q1 — should the lock move first? [blocking T03]');
  });

  it('opens a card whose Problem weighs its options in a table, with no --alternatives', async () => {
    await run(
      'open',
      '--title',
      'should the lock move first?',
      `--problem=${TABLE_PROBLEM}`,
      '--recommendation',
      'lock first',
      '--decision',
      'Move the lock.'
    );
    expect(out).toEqual(['Q1']);
    expect(status()).toContain('| lock first | one wait | — |');
    expect(status()).not.toContain('**Alternatives**');
  });

  it('reads a text argument from a file with @path', async () => {
    const problemPath = path.join(runDir, 'problem.md');
    writeFileSync(problemPath, `${PROBLEM.replace('late lock', 'a lock read from a file')}\n`);
    await run(
      ...OPEN_ARGS.flatMap((argument) =>
        argument.startsWith('--problem=') ? ['--problem', `@${problemPath}`] : [argument]
      )
    );
    expect(status()).toContain('**Problem** —\n- Found — a lock read from a file at settle.ts:40.');
  });

  it('opens from a drafted card file', async () => {
    const cardPath = path.join(runDir, 'card.md');
    writeFileSync(
      cardPath,
      `## Q77 — drafted? [blocking T02]\n\n**Problem** —\n${PROBLEM}\n\n**Recommendation** — r.\n\n**Decision** — d.\n\n**Alternatives** — a.\n`
    );
    await run('open', '--from', cardPath);
    expect(out).toEqual(['Q1']);
    expect(status()).toContain('## 📝 Q1 — drafted? [blocking T02]');
  });

  it('starts a drafted bulleted Problem on the line after its lead however the draft wrote it', async () => {
    const cardPath = path.join(runDir, 'card.md');
    writeFileSync(
      cardPath,
      `## Q77 — drafted? [blocking T02]\n\n**Problem** — ${PROBLEM}\n\n**Recommendation** — r.\n\n**Decision** — d.\n\n**Alternatives** — a.\n`
    );
    await run('open', '--from', cardPath);
    expect(status()).toContain(`**Problem** —\n${PROBLEM}`);
  });

  it('lists and shows', async () => {
    await run(...OPEN_ARGS);
    out = [];
    await run('list');
    expect(out).toEqual(['📝 Q1 — should the lock move first? [blocking T03]']);
    out = [];
    await run('list', '--ready');
    expect(out).toEqual([]);
    out = [];
    await run('show', 'Q1', '--field', 'Decision');
    expect(out).toEqual(['Move the lock.']);
    out = [];
    await run('show', '1');
    expect(out[0]).toContain('## 📝 Q1 —');
  });

  it('refuses an id that is not a Q-ID', async () => {
    await expect(run('show', 'seven')).rejects.toThrow(/Q-ID/);
  });

  it('refuses a missing id, a missing state, and a missing chart word', async () => {
    await expect(run('show')).rejects.toThrow(/got nothing/);
    await run(...OPEN_ARGS);
    await expect(run('state', 'Q1')).rejects.toThrow(/got nothing/);
    await expect(run('chart')).rejects.toThrow(/got nothing/);
  });

  it('opens without --blocks and lists the answered section', async () => {
    await run(...OPEN_ARGS.filter((argument) => argument !== '--blocks' && argument !== 'T03'));
    expect(status()).toContain('## 📝 Q1 — should the lock move first? [blocks nothing]');
    await run('answer', 'Q1', '--text', 'yes', '--work', 'w');
    out = [];
    await run('list', '--answered');
    expect(out).toEqual(['📝 Q1 — should the lock move first? [blocks nothing] → yes']);
  });
});

describe('edit', () => {
  beforeEach(async () => {
    await run(...OPEN_ARGS);
    out = [];
  });

  it('replaces a field, a string, and appends', async () => {
    await run('edit', 'Q1', '--field', 'Alternatives', '--text', 'none');
    await run(
      'edit',
      'Q1',
      '--field',
      'Problem',
      '--replace',
      'late lock',
      '--with',
      'a late lock'
    );
    await run('edit', 'Q1', '--field', 'Problem', '--append', 'and more');
    expect(status()).toContain('**Alternatives** — none');
    expect(status()).toContain('**Problem** —\n- Found — a late lock at settle.ts:40.');
    expect(status()).toContain('- Breaks — nothing else reads that row.\n\nand more');
  });

  it('removes a field, leaving every other byte of the file as it was', async () => {
    await run('edit', 'Q1', '--field', 'Problem', `--text=${TABLE_PROBLEM}`);
    const before = status();
    await run('edit', 'Q1', '--field', 'Alternatives', '--remove');
    expect(status()).not.toContain('**Alternatives**');
    expect(status()).toBe(before.replace('\n\n**Alternatives** — lock after', ''));
  });

  it('refuses removing a field every card carries', async () => {
    await expect(run('edit', 'Q1', '--field', 'Problem', '--remove')).rejects.toThrow(
      /Problem is a field every card carries/
    );
  });

  it('refuses removing a field a verb owns', async () => {
    await expect(run('edit', 'Q1', '--field', 'Answer', '--remove')).rejects.toThrow(/own verb/);
  });

  it.each([
    ['--text', ['--text', 'none']],
    ['--replace', ['--replace', 'lock after', '--with', 'lock later']],
    ['--append', ['--append', 'and more']],
  ])('refuses --remove beside %s', async (_form, argv) => {
    await expect(run('edit', 'Q1', '--field', 'Alternatives', '--remove', ...argv)).rejects.toThrow(
      /exactly one of/
    );
  });

  it('refuses two edit forms at once and none', async () => {
    await expect(
      run('edit', 'Q1', '--field', 'Problem', '--text', 'a', '--append', 'b')
    ).rejects.toThrow(/one of/);
    await expect(run('edit', 'Q1', '--field', 'Problem')).rejects.toThrow(/one of/);
    await expect(run('edit', 'Q1', '--field', 'Problem', '--replace', 'x')).rejects.toThrow(
      /--with/
    );
  });
});

describe('title', () => {
  beforeEach(async () => {
    await run(...OPEN_ARGS);
    out = [];
  });

  it('reframes the question, keeping the glyph, the id, and the blocking tag', async () => {
    await run('title', 'Q1', '--text', 'should the lock move at all?');
    expect(status()).toContain('## 📝 Q1 — should the lock move at all? [blocking T03]');
  });

  it('sets and clears the blocking tag', async () => {
    await run('title', 'Q1', '--blocks', 'T07', '--blocks', 'T08');
    expect(status()).toContain('[blocking T07, T08]');
    await run('title', 'Q1', '--unblock');
    expect(status()).toContain('[blocks nothing]');
  });

  it('refuses a line that names no change and one that names two', async () => {
    await expect(run('title', 'Q1')).rejects.toThrow(/--text/);
    await expect(run('title', 'Q1', '--blocks', 'T07', '--unblock')).rejects.toThrow(/--unblock/);
  });
});

describe('state, answer, pending, reopen, supersede', () => {
  beforeEach(async () => {
    await run(...OPEN_ARGS);
    out = [];
  });

  it('walks review to ready and answers with a ledger line', async () => {
    await run('state', 'Q1', 'review');
    expect(status()).toContain('## 🔍 Q1');
    await run('state', 'Q1', 'ready');
    expect(status()).toContain('| 0 | none | none | 0 | 1 (1 blocking) |');
    await run('answer', 'Q1', '--text', 'yes', '--work', 'T03 amended');
    expect(status()).toMatch(/## Answered\n\n## ✅ Q1 —/);
    expect(status()).toContain('**Answer:** yes\n\n**Work:** T03 amended');
    expect(readFileSync(path.join(runDir, 'ledger.md'), 'utf8')).toContain(
      '- Q1 ruled: "yes" → Work: T03 amended'
    );
  });

  it('files findings and refuses an unknown state', async () => {
    await run('state', 'Q1', 'findings', '--text', 'UNRESOLVED: "the gate"');
    expect(status()).toContain('## ⚠️ Q1');
    expect(status()).toContain('**Findings** — UNRESOLVED: "the gate"');
    await expect(run('state', 'Q1', 'done')).rejects.toThrow(/done/);
  });

  it('leaves no findings paragraph in the file once the card is ready', async () => {
    await run('state', 'Q1', 'findings', '--text', 'UNRESOLVED: "the gate"');
    await run('state', 'Q1', 'ready');
    expect(status()).toContain('## ✅ Q1');
    expect(status()).not.toContain('Findings');
    expect(status()).not.toContain('the gate');
  });

  it('finds a pending human answer and moves it', async () => {
    writeFileSync(
      path.join(runDir, 'status.md'),
      status().replace(
        '**Alternatives** — lock after',
        '**Alternatives** — lock after\n\n**Answer:** no'
      )
    );
    await run('pending');
    expect(out).toEqual(['📝 Q1 — should the lock move first? [blocking T03] → no']);
    await run('answer', 'Q1', '--work', 'none — deferred');
    expect(status()).toContain('**Answer:** no');
  });

  it('reopens and supersedes', async () => {
    await run('answer', 'Q1', '--text', 'yes', '--work', 'w');
    await run('reopen', 'Q1', '--correction', 'premise was false');
    expect(status()).toMatch(/## Open\n\n## 📝 Q1 —/);
    expect(status()).toContain('Correction — premise was false');
    await run('answer', 'Q1', '--text', 'yes again', '--work', 'w2');
    await run('supersede', 'Q1', '--text', 'no', '--work', 'w3');
    expect(status()).toContain('**Answer:** no (supersedes the answer above)');
    expect(readFileSync(path.join(runDir, 'ledger.md'), 'utf8')).toContain('supersedes');
  });
});

describe('withdraw', () => {
  beforeEach(async () => {
    await run(...OPEN_ARGS);
    out = [];
  });

  it('moves the card to Answered holding only its reason', async () => {
    await run('withdraw', 'Q1', '--reason', 'the lock was already first');
    expect(status()).toMatch(/## Answered\n\n## 📝 Q1 —/u);
    expect(status()).toContain('**Problem** — the lock was already first');
    expect(status()).toContain('**Answer:** withdrawn');
    expect(status()).toContain('**Work:** none — withdrawn');
    expect(status()).not.toContain('**Recommendation**');
  });

  it('appends exactly one line to the ledger', async () => {
    await run('withdraw', 'Q1', '--reason', 'the lock was already first');
    expect(readFileSync(path.join(runDir, 'ledger.md'), 'utf8')).toBe(
      '# Ledger\n- Q1 withdrawn: "the lock was already first"\n'
    );
  });

  it('refuses a Q-ID that is not in the file', async () => {
    await expect(run('withdraw', 'Q9', '--reason', 'r')).rejects.toThrow(/Q9 is not in Open/);
  });

  it('refuses a withdrawal that names no reason', async () => {
    await expect(run('withdraw', 'Q1')).rejects.toThrow(/--reason/);
  });
});

describe('show --blind', () => {
  beforeEach(async () => {
    await run(...OPEN_ARGS);
    out = [];
  });

  it('prints the title line above the Problem field', async () => {
    await run('show', 'Q1', '--blind');
    expect(out).toEqual([`## 📝 Q1 — should the lock move first? [blocking T03]\n\n${PROBLEM}`]);
  });

  it('withholds the Recommendation text', async () => {
    await run('show', 'Q1', '--blind');
    expect(out.join('\n')).not.toContain('lock first');
  });

  it('refuses --blind beside --field', async () => {
    await expect(run('show', 'Q1', '--blind', '--field', 'Decision')).rejects.toThrow(
      /--blind or --field, not both/
    );
  });
});

describe('chart and check', () => {
  it('sets, marks idle, and shows the chart', async () => {
    await run(
      'chart',
      'set',
      '--stamp',
      'after T04',
      '--done',
      '4',
      '--in-flight',
      'T05',
      '--blocked',
      'none',
      '--queued',
      '2'
    );
    expect(status()).toContain('📊 after T04');
    expect(status()).toContain('| 4 | T05 | none | 2 | 0 (0 blocking) |');
    await run('chart', 'idle', '--stamp', 'T03 waits on Q1');
    expect(status()).toContain('📊 idle — T03 waits on Q1');
    expect(status()).toContain('| 4 | T05 | none | 2 |');
    out = [];
    await run('chart', 'show');
    expect(out.join('\n')).toContain('| 4 | T05 | none | 2 | 0 (0 blocking) |');
    await expect(run('chart', 'dance')).rejects.toThrow(/dance/);
    await expect(run('chart', 'set', '--stamp', 's')).rejects.toThrow(/--done/);
  });

  it('checks a canonical file and names defects in a broken one', async () => {
    await run('check');
    expect(out).toEqual(['ok']);
    writeFileSync(
      path.join(runDir, 'status.md'),
      EMPTY.replace(
        '## Answered\n',
        '## Answered\n\n## Q3 — q? [blocks nothing]\n\n**Problem** — p.\n'
      )
    );
    await expect(run('check')).rejects.toThrow(/Q3/);
  });
});

describe('create', () => {
  it('writes a file the check verb accepts', async () => {
    rmSync(path.join(runDir, 'status.md'));
    await run('create');
    await run('check');
    expect(out).toEqual(['ok']);
  });

  it('carries the title the line gives it', async () => {
    rmSync(path.join(runDir, 'status.md'));
    await run('create', '--title', '2026-09-12 dedicated findings');
    expect(status()).toContain('# Status — 2026-09-12 dedicated findings');
  });

  it('names the run directory when the line gives no title', async () => {
    rmSync(path.join(runDir, 'status.md'));
    await run('create');
    expect(status()).toContain(`# Status — ${path.basename(runDir)}`);
  });

  it('names the run directory when the title flag is empty', async () => {
    rmSync(path.join(runDir, 'status.md'));
    await run('create', '--title', '');
    expect(status()).toContain(`# Status — ${path.basename(runDir)}`);
  });

  it('opens both card sections empty', async () => {
    rmSync(path.join(runDir, 'status.md'));
    await run('create');
    expect(status()).toMatch(/## Open\n\n## Answered\n$/u);
  });

  it('refuses a run that already has one, naming the file', async () => {
    await expect(run('create')).rejects.toThrow(/status\.md/);
    expect(status()).toBe(EMPTY);
  });

  it('takes a card straight after the file it creates', async () => {
    rmSync(path.join(runDir, 'status.md'));
    await run('create');
    await run(...OPEN_ARGS);
    expect(out).toEqual(['Q1']);
    expect(status()).toContain('## 📝 Q1 — should the lock move first? [blocking T03]');
  });
});
