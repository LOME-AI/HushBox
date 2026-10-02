import { describe, it, expect } from 'vitest';
import { CliUsageError, KIND_BY_ACTION, parseCommand } from './parse-command';

describe('parseCommand', () => {
  it('reads no flags at all as starting the console', () => {
    expect(parseCommand([])).toEqual({ kind: 'console' });
  });

  it('leaves every console flag to the launcher', () => {
    expect(parseCommand(['--port', '9333', '--no-idle', '--audit', '2026-07-30'])).toEqual({
      kind: 'console',
    });
  });

  it('reads a bare listing', () => {
    expect(parseCommand(['--list'])).toEqual({
      kind: 'list',
      audit: null,
      brief: false,
      contest: false,
      id: null,
      state: null,
      section: null,
      area: null,
      severity: null,
      progress: null,
    });
  });

  it('reads the listing filters in their equals form', () => {
    expect(parseCommand(['--list', '--state=ruled', '--area=apps/api', '--severity=high'])).toEqual(
      {
        kind: 'list',
        audit: null,
        brief: false,
        contest: false,
        id: null,
        state: 'ruled',
        section: null,
        area: 'apps/api',
        severity: 'high',
        progress: null,
      }
    );
  });

  it('reads a single-finding selection', () => {
    expect(parseCommand(['--list', '--id=AC-2'])).toMatchObject({ id: 'AC-2' });
  });

  it('reads a progress filter', () => {
    expect(parseCommand(['--list', '--progress=not-started'])).toMatchObject({
      progress: 'not-started',
    });
  });

  it('rejects a progress status outside the enum', () => {
    expect(() => parseCommand(['--list', '--progress=started'])).toThrow(
      '--progress must be one of not-started, in-progress, blocked, done'
    );
  });

  it('rejects a single-finding selection on a write action', () => {
    expect(() => parseCommand(['--set', 'AC-2', 'progress.status=done', '--id=AC-1'])).toThrow(
      '--id does not apply to --set'
    );
  });

  it('reads a listing filter in its separated form', () => {
    expect(parseCommand(['--list', '--state', 'open']).kind).toBe('list');
  });

  it('reads the brief flag', () => {
    expect(parseCommand(['--list', '--brief'])).toMatchObject({ brief: true });
  });

  it('reads an audit pin on an action', () => {
    expect(parseCommand(['--validate', '--audit', '2026-07-30'])).toEqual({
      kind: 'validate',
      audit: '2026-07-30',
    });
  });

  it('reads a field assignment', () => {
    expect(parseCommand(['--set', 'AC-2', 'progress.status=done'])).toEqual({
      kind: 'set',
      audit: null,
      id: 'AC-2',
      field: 'progress.status',
      value: 'done',
    });
  });

  it('keeps every equals sign after the first in the assigned value', () => {
    expect(parseCommand(['--set', 'AC-2', 'area=a=b'])).toMatchObject({
      field: 'area',
      value: 'a=b',
    });
  });

  it('reads a progress note', () => {
    expect(parseCommand(['--note', 'AC-2', 'index drafted'])).toEqual({
      kind: 'note',
      audit: null,
      id: 'AC-2',
      text: 'index drafted',
    });
  });

  it('reads an answer without an index', () => {
    expect(parseCommand(['--answer', 'AC-2', 'yes'])).toEqual({
      kind: 'answer',
      audit: null,
      id: 'AC-2',
      text: 'yes',
      index: null,
    });
  });

  it('reads an answer index', () => {
    expect(parseCommand(['--answer', 'AC-2', 'yes', '--index', '1'])).toMatchObject({ index: 1 });
  });

  it('reads a section as a filter of its own', () => {
    expect(parseCommand(['--list', '--section=blocked'])).toMatchObject({ section: 'blocked' });
  });

  it('reads every queue the console offers', () => {
    for (const id of ['open', 'questions', 'blocked', 'ruled', 'dedicated', 'denied', 'progress']) {
      expect(parseCommand(['--list', `--section=${id}`])).toMatchObject({ section: id });
    }
  });

  it('rejects the dashboard, which reads the whole audit rather than a queue', () => {
    expect(() => parseCommand(['--list', '--section=dashboard'])).toThrow(
      '--section must be one of'
    );
  });

  it('names the queues it accepts when it rejects a section', () => {
    expect(() => parseCommand(['--list', '--section=archive'])).toThrow(
      '--section must be one of open, questions, blocked, dedicated, ruled, denied, progress'
    );
  });

  it('rejects a state alongside a section, which filters the same thing', () => {
    expect(() => parseCommand(['--list', '--section=ruled', '--state=ruled'])).toThrow(
      '--section and --state'
    );
  });

  it('composes a section with the other filters and the brief', () => {
    expect(
      parseCommand([
        '--list',
        '--section=ruled',
        '--area=apps/api',
        '--severity=high',
        '--id=AC-2',
        '--brief',
      ])
    ).toMatchObject({
      section: 'ruled',
      area: 'apps/api',
      severity: 'high',
      id: 'AC-2',
      brief: true,
    });
  });

  it('reads the contest flag', () => {
    expect(parseCommand(['--list', '--contest'])).toMatchObject({ contest: true });
  });

  it('composes a contest with a section', () => {
    expect(parseCommand(['--list', '--section=ruled', '--contest'])).toMatchObject({
      section: 'ruled',
      contest: true,
    });
  });

  it('rejects a brief alongside a contest, which are two briefs', () => {
    expect(() => parseCommand(['--list', '--brief', '--contest'])).toThrow('--brief and --contest');
  });

  it('rejects a contest on a census, which has an output of its own', () => {
    expect(() => parseCommand(['--census', '--contest'])).toThrow(
      '--contest does not apply to --census'
    );
  });

  it('scopes a census to one section', () => {
    expect(parseCommand(['--census', '--section=blocked'])).toMatchObject({ section: 'blocked' });
  });

  it('reads a bare census', () => {
    expect(parseCommand(['--census'])).toEqual({
      kind: 'census',
      audit: null,
      id: null,
      state: null,
      section: null,
      area: null,
      severity: null,
      progress: null,
    });
  });

  it('reads a census pinned to one audit', () => {
    expect(parseCommand(['--census', '--audit', '2026-07-30'])).toMatchObject({
      audit: '2026-07-30',
    });
  });

  it('scopes a census with the listing filters', () => {
    expect(
      parseCommand(['--census', '--state=ruled', '--area=apps/api', '--severity=high', '--id=AC-2'])
    ).toMatchObject({
      state: 'ruled',
      area: 'apps/api',
      severity: 'high',
      id: 'AC-2',
    });
  });

  it('rejects a brief on a census, which has an output of its own', () => {
    expect(() => parseCommand(['--census', '--brief'])).toThrow(
      '--brief does not apply to --census'
    );
  });

  it('rejects an argument on a census', () => {
    expect(() => parseCommand(['--census', 'AC-2'])).toThrow('--census takes no arguments');
  });

  it('reads a bare questions request', () => {
    expect(parseCommand(['--questions'])).toEqual({
      kind: 'questions',
      audit: null,
      id: null,
      state: null,
      section: null,
      area: null,
      severity: null,
      progress: null,
    });
  });

  it('scopes a questions request with the listing filters', () => {
    expect(parseCommand(['--questions', '--area=apps/api', '--severity=high'])).toMatchObject({
      area: 'apps/api',
      severity: 'high',
    });
  });

  it('reads a questions request pinned to one audit', () => {
    expect(parseCommand(['--questions', '--audit', '2026-07-30'])).toMatchObject({
      audit: '2026-07-30',
    });
  });

  it('rejects a brief on a questions request, which has an output of its own', () => {
    expect(() => parseCommand(['--questions', '--brief'])).toThrow(
      '--brief does not apply to --questions'
    );
  });

  it('rejects an argument on a questions request', () => {
    expect(() => parseCommand(['--questions', 'AC-2'])).toThrow('--questions takes no arguments');
  });

  it('reads a denial carrying its mandate', () => {
    expect(parseCommand(['--deny', 'AC-2', '--mandate', 'the founder ruled it out'])).toEqual({
      kind: 'deny',
      audit: null,
      id: 'AC-2',
      mandate: 'the founder ruled it out',
    });
  });

  it('reads a withdrawal as the question index it drops', () => {
    expect(parseCommand(['--withdraw', 'AC-2', '1', '--mandate', 'answered elsewhere'])).toEqual({
      kind: 'withdraw',
      audit: null,
      id: 'AC-2',
      index: 1,
      mandate: 'answered elsewhere',
    });
  });

  it('rejects a withdrawal naming a question by anything but its index', () => {
    expect(() => parseCommand(['--withdraw', 'AC-2', 'first', '--mandate=why'])).toThrow(
      '--withdraw needs <ID> <n>'
    );
  });

  it('rejects a negative question index on a withdrawal', () => {
    expect(() => parseCommand(['--withdraw', 'AC-2', '-1', '--mandate=why'])).toThrow(
      '--withdraw needs <ID> <n>'
    );
  });

  it('reads a dedication as the mark it sets', () => {
    expect(parseCommand(['--dedicate', 'AC-2', 'true', '--mandate', 'needs a session'])).toEqual({
      kind: 'dedicate',
      audit: null,
      id: 'AC-2',
      dedicated: true,
      mandate: 'needs a session',
    });
  });

  it('reads a dedication being cleared', () => {
    expect(
      parseCommand(['--dedicate', 'AC-2', 'false', '--mandate=small enough after all'])
    ).toMatchObject({ dedicated: false });
  });

  it('rejects a dedication that is neither true nor false', () => {
    expect(() => parseCommand(['--dedicate', 'AC-2', 'yes', '--mandate=why'])).toThrow(
      '--dedicate needs <ID> true|false'
    );
  });

  it('reads a verification as the judgement it records', () => {
    expect(
      parseCommand(['--verify', 'AC-2', 'true', '--mandate', 'the founder checked it'])
    ).toEqual({
      kind: 'verify',
      audit: null,
      id: 'AC-2',
      verified: true,
      mandate: 'the founder checked it',
    });
  });

  it('reads a verification being withdrawn', () => {
    expect(parseCommand(['--verify', 'AC-2', 'false', '--mandate=it regressed'])).toMatchObject({
      verified: false,
    });
  });

  it('rejects a verification that is neither true nor false', () => {
    expect(() => parseCommand(['--verify', 'AC-2', 'done', '--mandate=why'])).toThrow(
      '--verify needs <ID> true|false'
    );
  });

  it('reads a status move as the status it writes', () => {
    expect(
      parseCommand(['--move', 'AC-2', 'done', '--mandate', 'the founder called it done'])
    ).toEqual({
      kind: 'move',
      audit: null,
      id: 'AC-2',
      status: 'done',
      mandate: 'the founder called it done',
    });
  });

  it('rejects a status move to a status the store does not admit', () => {
    expect(() => parseCommand(['--move', 'AC-2', 'nearly', '--mandate=why'])).toThrow(
      '--move needs <ID> not-started|in-progress|blocked|done'
    );
  });

  it('rejects a status move naming no status', () => {
    expect(() => parseCommand(['--move', 'AC-2', '--mandate=why'])).toThrow('--move needs <ID>');
  });

  it('refuses a status move carrying no mandate', () => {
    expect(() => parseCommand(['--move', 'AC-2', 'done'])).toThrow(
      "--mandate needs the human's own words"
    );
  });

  it('reads a remark as the mandate it records', () => {
    expect(parseCommand(['--remark', 'AC-2', '--mandate', 'read it again next week'])).toEqual({
      kind: 'remark',
      audit: null,
      id: 'AC-2',
      mandate: 'read it again next week',
    });
  });

  it('rejects a remark carrying words beside the mandate that is its text', () => {
    expect(() => parseCommand(['--remark', 'AC-2', 'and this too', '--mandate=why'])).toThrow(
      '--remark needs <ID>'
    );
  });

  it('refuses a remark carrying no mandate', () => {
    expect(() => parseCommand(['--remark', 'AC-2'])).toThrow(
      "--mandate needs the human's own words"
    );
  });

  it('reads a ruling as the option it picks', () => {
    expect(parseCommand(['--rule', 'AC-2', 'b', '--mandate', 'cheapest to hold'])).toEqual({
      kind: 'rule',
      audit: null,
      id: 'AC-2',
      option: 'b',
      mandate: 'cheapest to hold',
    });
  });

  it('rejects a ruling naming no option', () => {
    expect(() => parseCommand(['--rule', 'AC-2', '--mandate=why'])).toThrow(
      '--rule needs <ID> <option>'
    );
  });

  it('rejects a ruling whose option is empty', () => {
    expect(() => parseCommand(['--rule', 'AC-2', '', '--mandate=why'])).toThrow(
      '--rule needs <ID> <option>'
    );
  });

  it('rejects a ruling whose option is only whitespace', () => {
    expect(() => parseCommand(['--rule', 'AC-2', '   ', '--mandate=why'])).toThrow(
      '--rule needs <ID> <option>'
    );
  });

  it('reads a ruling option without the spaces around it', () => {
    expect(parseCommand(['--rule', 'AC-2', ' b ', '--mandate=why'])).toMatchObject({ option: 'b' });
  });

  it('reads what a ruling decided, apart from the option it picks', () => {
    expect(
      parseCommand([
        '--rule',
        'AC-2',
        'b',
        '--mandate=the founder said so',
        '--text=neither, cache',
      ])
    ).toMatchObject({ option: 'b', text: 'neither, cache', mandate: 'the founder said so' });
  });

  it('leaves the decision unwritten when a ruling gives none of its own', () => {
    expect(parseCommand(['--rule', 'AC-2', 'b', '--mandate=why'])).not.toHaveProperty('text');
  });

  it('keeps a decision text off every action but a ruling', () => {
    for (const flag of Object.keys(KIND_BY_ACTION)) {
      if (flag === '--rule') continue;
      expect(() => parseCommand([flag, '--text=what'])).toThrow(`--text does not apply to ${flag}`);
    }
  });

  it('refuses a ruling text that is only whitespace', () => {
    expect(() => parseCommand(['--rule', 'AC-2', 'b', '--mandate=why', '--text', '   '])).toThrow(
      '--text needs a value'
    );
  });

  it('reads a ruling that also marks the finding for a session of its own', () => {
    expect(
      parseCommand(['--rule', 'AC-2', 'b', '--mandate=why', '--dedicated=true'])
    ).toMatchObject({ option: 'b', dedicated: true });
  });

  it('reads an unblocking that also clears the mark', () => {
    expect(
      parseCommand(['--unblock', 'AC-2', '--mandate=use the second option', '--dedicated', 'false'])
    ).toMatchObject({ kind: 'unblock', dedicated: false });
  });

  it('reads a ruling that decides, says so in its own words and marks the finding', () => {
    expect(
      parseCommand([
        '--rule',
        'AC-2',
        'b',
        '--mandate=the founder ruled it',
        '--text=b, but only the cache half',
        '--dedicated=true',
      ])
    ).toEqual({
      kind: 'rule',
      audit: null,
      id: 'AC-2',
      option: 'b',
      mandate: 'the founder ruled it',
      text: 'b, but only the cache half',
      dedicated: true,
    });
  });

  it('leaves the mark unnamed by a ruling that says nothing about it', () => {
    expect(parseCommand(['--rule', 'AC-2', 'b', '--mandate=why'])).not.toHaveProperty('dedicated');
  });

  it('leaves the mark unnamed by an unblocking that says nothing about it', () => {
    expect(parseCommand(['--unblock', 'AC-2', '--mandate=why'])).not.toHaveProperty('dedicated');
  });

  it('keeps the dedication rider off every action but a ruling and an unblocking', () => {
    for (const flag of Object.keys(KIND_BY_ACTION)) {
      if (flag === '--rule' || flag === '--unblock') continue;
      expect(() => parseCommand([flag, '--dedicated=true'])).toThrow(
        `--dedicated does not apply to ${flag}`
      );
    }
  });

  it('rejects a dedication rider that is neither true nor false', () => {
    expect(() => parseCommand(['--rule', 'AC-2', 'b', '--mandate=why', '--dedicated=yes'])).toThrow(
      '--dedicated must be one of true, false'
    );
  });

  it('reads a question as the text it asks', () => {
    expect(
      parseCommand(['--ask', 'AC-2', 'which option?', '--mandate', 'the founder asks'])
    ).toEqual({
      kind: 'ask',
      audit: null,
      id: 'AC-2',
      text: 'which option?',
      mandate: 'the founder asks',
    });
  });

  it('rejects a question whose text is empty', () => {
    expect(() => parseCommand(['--ask', 'AC-2', '', '--mandate=why'])).toThrow(
      '--ask needs <ID> "<question>"'
    );
  });

  it('rejects a question whose text is only whitespace', () => {
    expect(() => parseCommand(['--ask', 'AC-2', '   ', '--mandate=why'])).toThrow(
      '--ask needs <ID> "<question>"'
    );
  });

  it('reads a question without the spaces around it', () => {
    expect(parseCommand(['--ask', 'AC-2', ' which option? ', '--mandate=why'])).toMatchObject({
      text: 'which option?',
    });
  });

  it('reads a reopening carrying its mandate', () => {
    expect(parseCommand(['--reopen', 'AC-2', '--mandate', 'the denial was wrong'])).toEqual({
      kind: 'reopen',
      audit: null,
      id: 'AC-2',
      mandate: 'the denial was wrong',
    });
  });

  it('reads an unblocking carrying its mandate', () => {
    expect(parseCommand(['--unblock', 'AC-2', '--mandate', 'use the second option'])).toEqual({
      kind: 'unblock',
      audit: null,
      id: 'AC-2',
      mandate: 'use the second option',
    });
  });

  it('refuses a mandated action carrying no mandate', () => {
    expect(() => parseCommand(['--deny', 'AC-2'])).toThrow("--mandate needs the human's own words");
  });

  it('says what a mandate is for when it refuses one', () => {
    expect(() => parseCommand(['--deny', 'AC-2'])).toThrow(
      'a mandated action records their decision on the finding'
    );
  });

  it('refuses an empty mandate in the words a missing one is refused in', () => {
    expect(() => parseCommand(['--deny', 'AC-2', '--mandate='])).toThrow(
      "--mandate needs the human's own words"
    );
  });

  it('refuses a mandate that is only whitespace', () => {
    expect(() => parseCommand(['--deny', 'AC-2', '--mandate', '   '])).toThrow(
      "--mandate needs the human's own words"
    );
  });

  it('keeps a mandate off every action that decides nothing', () => {
    const unmandated = [
      '--list',
      '--census',
      '--questions',
      '--set',
      '--note',
      '--answer',
      '--validate',
      '--help',
    ];
    for (const flag of unmandated) {
      expect(() => parseCommand([flag, '--mandate=why'])).toThrow(
        `--mandate does not apply to ${flag}`
      );
    }
  });

  it('refuses two mandated actions in one invocation', () => {
    expect(() => parseCommand(['--deny', 'AC-2', '--reopen', '--mandate=why'])).toThrow(
      'use one action at a time, not --deny and --reopen'
    );
  });

  it('rejects a denial naming no finding', () => {
    expect(() => parseCommand(['--deny', '--mandate=why'])).toThrow('--deny needs <ID>');
  });

  it('rejects a second argument on a denial', () => {
    expect(() => parseCommand(['--deny', 'AC-2', 'AC-3', '--mandate=why'])).toThrow(
      '--deny needs <ID>'
    );
  });

  it('reads the validate action', () => {
    expect(parseCommand(['--validate'])).toEqual({ kind: 'validate', audit: null });
  });

  it('reads the help action rather than starting the console', () => {
    expect(parseCommand(['--help'])).toEqual({ kind: 'help' });
  });

  it('rejects an audit pin on help, which reads no audit', () => {
    expect(() => parseCommand(['--help', '--audit', '2026-07-30'])).toThrow(
      '--audit does not apply to --help'
    );
  });

  it('rejects an argument on help', () => {
    expect(() => parseCommand(['--help', 'AC-2'])).toThrow('--help takes no arguments');
  });

  it('rejects an unknown flag rather than ignoring a typo', () => {
    expect(() => parseCommand(['--list', '--sevrity=high'])).toThrow(CliUsageError);
  });

  it('names the unknown flag it rejected', () => {
    expect(() => parseCommand(['--list', '--sevrity=high'])).toThrow('--sevrity');
  });

  it('rejects a console flag alongside an action', () => {
    expect(() => parseCommand(['--list', '--port', '9333'])).toThrow(
      '--port does not apply to --list'
    );
  });

  it('rejects a filter without a listing', () => {
    expect(() => parseCommand(['--validate', '--brief'])).toThrow(
      '--brief does not apply to --validate'
    );
  });

  it('rejects two actions in one invocation', () => {
    expect(() => parseCommand(['--list', '--validate'])).toThrow('one action at a time');
  });

  it('rejects a missing value', () => {
    expect(() => parseCommand(['--list', '--state'])).toThrow('--state needs a value');
  });

  it('rejects an empty value', () => {
    expect(() => parseCommand(['--list', '--area='])).toThrow('--area needs a value');
  });

  it('rejects a state outside the enum', () => {
    expect(() => parseCommand(['--list', '--state=maybe'])).toThrow(
      '--state must be one of open, ruled, denied'
    );
  });

  it('rejects a severity outside the enum', () => {
    expect(() => parseCommand(['--list', '--severity=urgent'])).toThrow(
      '--severity must be one of'
    );
  });

  it('rejects a non-numeric index', () => {
    expect(() => parseCommand(['--answer', 'AC-2', 'yes', '--index', 'first'])).toThrow(
      '--index needs a whole number'
    );
  });

  it('rejects a negative index', () => {
    expect(() => parseCommand(['--answer', 'AC-2', 'yes', '--index', '-1'])).toThrow(
      '--index needs a whole number'
    );
  });

  it('rejects an assignment with no equals sign', () => {
    expect(() => parseCommand(['--set', 'AC-2', 'done'])).toThrow('--set needs field=value');
  });

  it('rejects an assignment with an empty field', () => {
    expect(() => parseCommand(['--set', 'AC-2', '=done'])).toThrow('--set needs field=value');
  });

  it('rejects an assignment with an empty value', () => {
    expect(() => parseCommand(['--set', 'AC-2', 'progress='])).toThrow('--set needs a value');
  });

  it('rejects too few arguments', () => {
    expect(() => parseCommand(['--note', 'AC-2'])).toThrow('--note needs <ID> "<text>"');
  });

  it('rejects too many arguments', () => {
    expect(() => parseCommand(['--validate', 'AC-2'])).toThrow('--validate takes no arguments');
  });

  it('rejects an argument on a listing', () => {
    expect(() => parseCommand(['--list', 'AC-2'])).toThrow('--list takes no arguments');
  });

  it('rejects a third argument on a note', () => {
    expect(() => parseCommand(['--note', 'AC-2', 'one', 'two'])).toThrow(
      '--note needs <ID> "<text>"'
    );
  });

  it('rejects an action with no arguments at all', () => {
    expect(() => parseCommand(['--set'])).toThrow('--set needs <ID> field=value');
  });

  it('rejects an inline value on an action flag', () => {
    expect(() => parseCommand(['--list=all'])).toThrow('--list takes no value');
  });
});
