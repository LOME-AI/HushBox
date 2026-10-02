import { describe, it, expect } from 'vitest';
import {
  RUNNABLE_DOCUMENT_KINDS,
  RunnableDocumentKind,
  DOCUMENT_THEMES,
  DocumentTheme,
  DocumentColour,
  ThemeMessage,
  DOCUMENT_ERROR_CODES,
  DocumentErrorCode,
  LOADING_PHASES,
  CONSOLE_STREAMS,
  ResultOutput,
  InitMessage,
  RunMessage,
  StopMessage,
  ParentToFrameMessage,
  ReadyMessage,
  RenderedMessage,
  ConsoleMessage,
  ResultMessage,
  ErrorMessage,
  LoadingMessage,
  FrameToParentMessage,
  parseParentToFrameMessage,
  parseFrameToParentMessage,
  DOCUMENT_CONSOLE_TEXT_MAX_LENGTH,
  DOCUMENT_ERROR_MESSAGE_MAX_LENGTH,
  DOCUMENT_RESULT_OUTPUT_MAX_LENGTH,
  DOCUMENT_RESULT_OUTPUTS_MAX,
  DOCUMENT_RUN_MESSAGE_BUDGET,
  DOCUMENT_RUN_OUTPUT_BUDGET_BYTES,
  OUTPUT_BUDGET_SPENT_NOTICE,
  clampDocumentText,
  clampResultOutputs,
  createDocumentOutputBudget,
} from './bridge.ts';
import type { LoadingPhase, ConsoleStream } from './bridge.ts';

describe('RunnableDocumentKind', () => {
  it('accepts each runnable kind', () => {
    for (const kind of RUNNABLE_DOCUMENT_KINDS) {
      expect(RunnableDocumentKind.parse(kind)).toBe(kind);
    }
  });

  it('rejects a non-runnable kind (mermaid stays outside the bridge)', () => {
    expect(RunnableDocumentKind.safeParse('mermaid').success).toBe(false);
  });
});

describe('DocumentTheme', () => {
  it('accepts each theme', () => {
    for (const theme of DOCUMENT_THEMES) {
      expect(DocumentTheme.parse(theme)).toBe(theme);
    }
  });

  it('rejects a theme outside the closed set', () => {
    expect(DocumentTheme.safeParse('sepia').success).toBe(false);
  });
});

describe('DocumentColour', () => {
  it('accepts a six-digit hex colour in either case', () => {
    expect(DocumentColour.parse('#faf9f6')).toBe('#faf9f6');
    expect(DocumentColour.parse('#1A1816')).toBe('#1A1816');
  });

  it('rejects anything that is not six hex digits', () => {
    for (const value of ['#fff', 'red', 'var(--background)', 'rgb(0,0,0)', '#faf9f']) {
      expect(DocumentColour.safeParse(value).success).toBe(false);
    }
  });

  it('rejects a value carrying CSS declaration or block syntax', () => {
    // The frame writes these into a stylesheet, so the pattern is what keeps a
    // colour from being anything but a colour: `;`, `{` and `}` are the three
    // characters that would let a value close the declaration and open a rule
    // of the attacker's own, and none of them is a hex digit.
    for (const value of ['#fff;}html{color:red', '#faf9f6;color:red', '#faf9f6}']) {
      expect(DocumentColour.safeParse(value).success).toBe(false);
    }
  });
});

describe('parent→frame: init', () => {
  it('round-trips a valid init message', () => {
    const msg = { type: 'init', kind: 'react', code: 'export default () => null', requestId: 'r1' };
    expect(InitMessage.parse(msg)).toEqual(msg);
  });

  it('rejects init with an unknown kind', () => {
    const parsed = InitMessage.safeParse({
      type: 'init',
      kind: 'ruby',
      code: 'x',
      requestId: 'r1',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects init with an empty requestId', () => {
    const parsed = InitMessage.safeParse({ type: 'init', kind: 'html', code: 'x', requestId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects init missing the code field', () => {
    const parsed = InitMessage.safeParse({ type: 'init', kind: 'html', requestId: 'r1' });
    expect(parsed.success).toBe(false);
  });

  it('carries the theme the embedder states', () => {
    const msg = { type: 'init', kind: 'html', code: 'x', requestId: 'r1', theme: 'dark' };
    expect(InitMessage.parse(msg)).toEqual(msg);
  });

  it('rejects init with a theme outside the closed set', () => {
    const parsed = InitMessage.safeParse({
      type: 'init',
      kind: 'html',
      code: 'x',
      requestId: 'r1',
      theme: 'sepia',
    });
    expect(parsed.success).toBe(false);
  });

  it('carries the colours the embedder resolved', () => {
    const msg = {
      type: 'init',
      kind: 'html',
      code: 'x',
      requestId: 'r1',
      theme: 'dark',
      background: '#1a1816',
      foreground: '#f2f1ef',
    };
    expect(InitMessage.parse(msg)).toEqual(msg);
  });

  it('rejects init with a colour that is not six-digit hex', () => {
    const parsed = InitMessage.safeParse({
      type: 'init',
      kind: 'html',
      code: 'x',
      requestId: 'r1',
      background: 'rgb(0,0,0)',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('parent→frame: theme', () => {
  it('round-trips an appearance with no document attached to it', () => {
    // Restyling is its own message precisely because it names no request and
    // carries no code: the frame applies it without touching whatever is
    // running, which an `init` cannot do.
    const msg = { type: 'theme', theme: 'light', background: '#faf9f6', foreground: '#1a1a1a' };
    expect(ThemeMessage.parse(msg)).toEqual(msg);
  });

  it('accepts a theme message stating only the colour scheme', () => {
    const msg = { type: 'theme', theme: 'dark' };
    expect(ThemeMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a theme message with a colour that is not six-digit hex', () => {
    expect(ThemeMessage.safeParse({ type: 'theme', foreground: 'white' }).success).toBe(false);
  });
});

describe('parent→frame: run and stop', () => {
  it('round-trips run', () => {
    expect(RunMessage.parse({ type: 'run', requestId: 'r2' })).toEqual({
      type: 'run',
      requestId: 'r2',
    });
  });

  it('round-trips stop', () => {
    expect(StopMessage.parse({ type: 'stop', requestId: 'r3' })).toEqual({
      type: 'stop',
      requestId: 'r3',
    });
  });
});

describe('ParentToFrameMessage union', () => {
  it('discriminates init, run, stop, and theme', () => {
    expect(
      ParentToFrameMessage.parse({ type: 'init', kind: 'js', code: 'x', requestId: 'a' }).type
    ).toBe('init');
    expect(ParentToFrameMessage.parse({ type: 'run', requestId: 'a' }).type).toBe('run');
    expect(ParentToFrameMessage.parse({ type: 'stop', requestId: 'a' }).type).toBe('stop');
    expect(ParentToFrameMessage.parse({ type: 'theme', theme: 'dark' }).type).toBe('theme');
  });

  it('rejects a frame→parent message shape', () => {
    expect(ParentToFrameMessage.safeParse({ type: 'ready' }).success).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(ParentToFrameMessage.safeParse('nope').success).toBe(false);
    expect(ParentToFrameMessage.safeParse(null).success).toBe(false);
  });
});

describe('frame→parent messages', () => {
  it('round-trips ready (no requestId — sent once on load)', () => {
    expect(ReadyMessage.parse({ type: 'ready' })).toEqual({ type: 'ready' });
  });

  it('round-trips rendered', () => {
    expect(RenderedMessage.parse({ type: 'rendered', requestId: 'r' })).toEqual({
      type: 'rendered',
      requestId: 'r',
    });
  });

  it('round-trips a stdout console line', () => {
    const msg = { type: 'console', requestId: 'r', stream: 'stdout', text: 'hi' };
    expect(ConsoleMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a console line with an unknown stream', () => {
    expect(
      ConsoleMessage.safeParse({ type: 'console', requestId: 'r', stream: 'log', text: 'hi' })
        .success
    ).toBe(false);
  });

  it('round-trips a result with png and text outputs', () => {
    const msg = {
      type: 'result',
      requestId: 'r',
      outputs: [
        { type: 'image/png', data: 'base64==' },
        { type: 'text', data: 'done' },
      ],
    };
    expect(ResultMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a result output with an unknown type', () => {
    expect(ResultOutput.safeParse({ type: 'image/jpeg', data: 'x' }).success).toBe(false);
  });

  it('round-trips an error with a closed code', () => {
    const msg = { type: 'error', requestId: 'r', code: 'transpile_failed', message: 'bad jsx' };
    expect(ErrorMessage.parse(msg)).toEqual(msg);
  });

  it('rejects an error with an unknown code', () => {
    expect(
      ErrorMessage.safeParse({ type: 'error', requestId: 'r', code: 'kaboom', message: 'x' })
        .success
    ).toBe(false);
  });

  it('round-trips a loading phase', () => {
    const msg = { type: 'loading', requestId: 'r', phase: 'transpiling' };
    expect(LoadingMessage.parse(msg)).toEqual(msg);
  });

  it('rejects a loading message with an unknown phase', () => {
    expect(
      LoadingMessage.safeParse({ type: 'loading', requestId: 'r', phase: 'warp' }).success
    ).toBe(false);
  });
});

describe('FrameToParentMessage union', () => {
  it('discriminates every frame→parent variant', () => {
    expect(FrameToParentMessage.parse({ type: 'ready' }).type).toBe('ready');
    expect(FrameToParentMessage.parse({ type: 'rendered', requestId: 'r' }).type).toBe('rendered');
    expect(
      FrameToParentMessage.parse({ type: 'console', requestId: 'r', stream: 'stderr', text: 'e' })
        .type
    ).toBe('console');
    expect(FrameToParentMessage.parse({ type: 'result', requestId: 'r', outputs: [] }).type).toBe(
      'result'
    );
    expect(
      FrameToParentMessage.parse({
        type: 'error',
        requestId: 'r',
        code: 'import_failed',
        message: 'm',
      }).type
    ).toBe('error');
    expect(
      FrameToParentMessage.parse({ type: 'loading', requestId: 'r', phase: 'executing' }).type
    ).toBe('loading');
  });

  it('rejects a parent→frame message shape', () => {
    expect(
      FrameToParentMessage.safeParse({ type: 'init', kind: 'html', code: 'x', requestId: 'r' })
        .success
    ).toBe(false);
  });
});

describe('parse helpers', () => {
  it('parseParentToFrameMessage returns a typed success for a valid message', () => {
    const result = parseParentToFrameMessage({ type: 'run', requestId: 'r' });
    expect(result.success).toBe(true);
    // Narrowed on the discriminant, because not every parent→frame message
    // names a request: a restyle applies to the frame, not to a run.
    if (result.success && result.data.type === 'run') expect(result.data.requestId).toBe('r');
  });

  it('parseParentToFrameMessage returns failure (never throws) for garbage', () => {
    expect(parseParentToFrameMessage(42).success).toBe(false);
  });

  it('parseFrameToParentMessage returns a typed success for a valid message', () => {
    const result = parseFrameToParentMessage({ type: 'ready' });
    expect(result.success).toBe(true);
  });

  it('parseFrameToParentMessage returns failure (never throws) for garbage', () => {
    expect(parseFrameToParentMessage(null).success).toBe(false);
  });
});

describe('exhaustive constant sets', () => {
  it('exposes the closed constant tuples the UI switches over', () => {
    expect(RUNNABLE_DOCUMENT_KINDS).toEqual(['html', 'js', 'react', 'python']);
    expect(CONSOLE_STREAMS).toEqual(['stdout', 'stderr']);
    expect(LOADING_PHASES.length).toBeGreaterThan(0);
    expect(DOCUMENT_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('carries the code the app mints when a frame never announces itself', () => {
    // The one code no frame message can carry: a frame that never completed the
    // handshake has no port to report anything on, so the app mints it.
    expect(DocumentErrorCode.safeParse('frame_unavailable').success).toBe(true);
  });

  it('derives enum types from the tuples', () => {
    const kind: RunnableDocumentKind = 'python';
    const stream: ConsoleStream = 'stderr';
    const phase: LoadingPhase = LOADING_PHASES[0];
    const code: DocumentErrorCode = DOCUMENT_ERROR_CODES[0];
    expect([kind, stream, phase, code]).toHaveLength(4);
  });
});

describe('bridge payload caps', () => {
  it('accepts a console line at exactly the text cap', () => {
    const text = 'x'.repeat(DOCUMENT_CONSOLE_TEXT_MAX_LENGTH);
    expect(
      ConsoleMessage.safeParse({ type: 'console', requestId: 'r', stream: 'stdout', text }).success
    ).toBe(true);
  });

  it('rejects a console line longer than the text cap', () => {
    const text = 'x'.repeat(DOCUMENT_CONSOLE_TEXT_MAX_LENGTH + 1);
    expect(
      ConsoleMessage.safeParse({ type: 'console', requestId: 'r', stream: 'stdout', text }).success
    ).toBe(false);
  });

  it('rejects an error message longer than the message cap', () => {
    const message = 'x'.repeat(DOCUMENT_ERROR_MESSAGE_MAX_LENGTH + 1);
    expect(
      ErrorMessage.safeParse({ type: 'error', requestId: 'r', code: 'runtime_error', message })
        .success
    ).toBe(false);
  });

  it('rejects a png output longer than the output cap', () => {
    const data = 'x'.repeat(DOCUMENT_RESULT_OUTPUT_MAX_LENGTH + 1);
    expect(ResultOutput.safeParse({ type: 'image/png', data }).success).toBe(false);
  });

  it('rejects a text output longer than the output cap', () => {
    const data = 'x'.repeat(DOCUMENT_RESULT_OUTPUT_MAX_LENGTH + 1);
    expect(ResultOutput.safeParse({ type: 'text', data }).success).toBe(false);
  });

  it('rejects a result carrying more outputs than the array cap', () => {
    const outputs = Array.from({ length: DOCUMENT_RESULT_OUTPUTS_MAX + 1 }, () => ({
      type: 'text' as const,
      data: 'out',
    }));
    expect(ResultMessage.safeParse({ type: 'result', requestId: 'r', outputs }).success).toBe(
      false
    );
  });
});

describe('clampDocumentText', () => {
  it('returns text within the cap unchanged', () => {
    expect(clampDocumentText('short enough', 100)).toBe('short enough');
  });

  it('brings over-long text within the cap', () => {
    expect(clampDocumentText('x'.repeat(9000), 4096).length).toBeLessThanOrEqual(4096);
  });

  it('keeps the head and the tail of over-long text', () => {
    const clamped = clampDocumentText(`head${'x'.repeat(9000)}tail`, 4096);
    expect(clamped.startsWith('head')).toBe(true);
    expect(clamped.endsWith('tail')).toBe(true);
  });

  it('names how many characters it elided', () => {
    const clamped = clampDocumentText('x'.repeat(9000), 4096);
    const kept = clamped.length - clamped.replaceAll('x', '').length;
    expect(clamped).toContain(`[${String(9000 - kept)} characters elided]`);
  });

  it('clamps at the narrowest cap the elision marker fits inside', () => {
    // 500 characters elide through a 29-character marker, so 29 is the
    // narrowest cap that can carry the notice and still be honoured.
    const clamped = clampDocumentText('x'.repeat(500), 29);
    expect(clamped.length).toBe(29);
    expect(clamped).toBe(' … [500 characters elided] … ');
  });

  it('rejects a cap the elision marker cannot fit inside', () => {
    expect(() => clampDocumentText('x'.repeat(500), 28)).toThrow(
      'clampDocumentText: maxLength 28 cannot hold the 29-character elision marker'
    );
  });

  it('produces a console line the bridge schema accepts', () => {
    const text = clampDocumentText('x'.repeat(1_000_000), DOCUMENT_CONSOLE_TEXT_MAX_LENGTH);
    expect(
      ConsoleMessage.safeParse({ type: 'console', requestId: 'r', stream: 'stdout', text }).success
    ).toBe(true);
  });

  it('produces an error message the bridge schema accepts', () => {
    const message = clampDocumentText('x'.repeat(1_000_000), DOCUMENT_ERROR_MESSAGE_MAX_LENGTH);
    expect(
      ErrorMessage.safeParse({ type: 'error', requestId: 'r', code: 'python_error', message })
        .success
    ).toBe(true);
  });
});

describe('clampResultOutputs', () => {
  it('passes a legitimate multi-figure result through unchanged', () => {
    const figures = Array.from({ length: DOCUMENT_RESULT_OUTPUTS_MAX }, (_unused, index) => ({
      type: 'image/png' as const,
      data: `iVBORw0KGgo${String(index)}`,
    }));
    expect(clampResultOutputs(figures)).toEqual(figures);
  });

  it('replaces an over-cap figure with a text note rather than a corrupt image', () => {
    const clamped = clampResultOutputs([
      { type: 'image/png', data: 'x'.repeat(DOCUMENT_RESULT_OUTPUT_MAX_LENGTH + 1) },
    ]);
    expect(clamped[0]?.type).toBe('text');
    expect(clamped[0]?.data).toMatch(/omitted/);
  });

  it('names the overage of an over-cap figure, not the figure size', () => {
    const clamped = clampResultOutputs([
      { type: 'image/png', data: 'x'.repeat(DOCUMENT_RESULT_OUTPUT_MAX_LENGTH + 1000) },
    ]);
    expect(clamped[0]?.data).toBe(
      `[figure omitted: 1000 characters over the ${String(DOCUMENT_RESULT_OUTPUT_MAX_LENGTH)}-character ceiling]`
    );
  });

  it('truncates an over-cap text output rather than replacing it', () => {
    const clamped = clampResultOutputs([
      { type: 'text', data: `head${'x'.repeat(DOCUMENT_RESULT_OUTPUT_MAX_LENGTH)}tail` },
    ]);
    expect(clamped[0]?.type).toBe('text');
    expect(clamped[0]?.data.startsWith('head')).toBe(true);
    expect(clamped[0]?.data.endsWith('tail')).toBe(true);
    expect((clamped[0]?.data ?? '').length).toBeLessThanOrEqual(DOCUMENT_RESULT_OUTPUT_MAX_LENGTH);
  });

  it('truncates an over-long output list and names how many it dropped', () => {
    const figures = Array.from({ length: DOCUMENT_RESULT_OUTPUTS_MAX + 5 }, () => ({
      type: 'image/png' as const,
      data: 'iVBORw0KGgo',
    }));
    const clamped = clampResultOutputs(figures);
    expect(clamped.length).toBe(DOCUMENT_RESULT_OUTPUTS_MAX);
    expect(clamped.at(-1)?.data).toMatch(/6 further outputs omitted/);
  });

  it('produces a result the bridge schema accepts', () => {
    const figures = Array.from({ length: DOCUMENT_RESULT_OUTPUTS_MAX + 5 }, () => ({
      type: 'image/png' as const,
      data: 'x'.repeat(DOCUMENT_RESULT_OUTPUT_MAX_LENGTH + 1),
    }));
    const outputs = clampResultOutputs(figures);
    expect(ResultMessage.safeParse({ type: 'result', requestId: 'r', outputs }).success).toBe(true);
  });
});

describe('createDocumentOutputBudget', () => {
  it('admits output until the run byte budget is spent', () => {
    const budget = createDocumentOutputBudget();
    const line = 'x'.repeat(DOCUMENT_CONSOLE_TEXT_MAX_LENGTH);
    let admitted = 0;
    while (budget.admit(line)) admitted += 1;
    expect(admitted).toBe(DOCUMENT_RUN_OUTPUT_BUDGET_BYTES / DOCUMENT_CONSOLE_TEXT_MAX_LENGTH);
  });

  it('admits output until the run message budget is spent', () => {
    const budget = createDocumentOutputBudget();
    let admitted = 0;
    while (budget.admit('.')) admitted += 1;
    expect(admitted).toBe(DOCUMENT_RUN_MESSAGE_BUDGET);
  });

  it('stays spent once the budget is exhausted', () => {
    const budget = createDocumentOutputBudget();
    let spending = true;
    while (spending) spending = budget.admit('.');
    expect(budget.admit('.')).toBe(false);
  });

  it('meters text by its utf-8 byte length, not its character count', () => {
    const budget = createDocumentOutputBudget();
    // Three bytes per character, so a budget counting bytes admits a third of
    // what one counting characters would.
    const line = '€'.repeat(DOCUMENT_CONSOLE_TEXT_MAX_LENGTH);
    let admitted = 0;
    while (budget.admit(line)) admitted += 1;
    expect(admitted).toBe(
      Math.floor(DOCUMENT_RUN_OUTPUT_BUDGET_BYTES / (DOCUMENT_CONSOLE_TEXT_MAX_LENGTH * 3))
    );
  });
});

describe('OUTPUT_BUDGET_SPENT_NOTICE', () => {
  it('fits inside the console text cap it is sent through', () => {
    expect(OUTPUT_BUDGET_SPENT_NOTICE.length).toBeLessThanOrEqual(DOCUMENT_CONSOLE_TEXT_MAX_LENGTH);
  });
});
