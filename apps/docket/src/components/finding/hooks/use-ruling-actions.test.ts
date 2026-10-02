import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { act, renderHook } from '@testing-library/react';
import { AuditAddressProvider } from '@/api/audit-address';
import { makeFinding } from '@/test-utils/finding-fixture';
import { sectionSpec } from '@/components/shell/logic/sections';
import { withAuditAddress } from '@/test-utils/audit-address';
import { createWriteStore, nextInQueue, useRulingActions } from './use-ruling-actions';
import type { RulingActionsOptions } from './use-ruling-actions';
import type { FindingJson } from '@hushbox/docket';
import type { JSX, ReactNode } from 'react';

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** A fresh Response per call: a body may be read only once, and a retry re-reads. */
function responds(status: number, body: unknown): () => Promise<Response> {
  return () => Promise.resolve(jsonResponse(status, body));
}

const queue: readonly FindingJson[] = [
  makeFinding({ id: 'A-1', state: 'open' }),
  makeFinding({ id: 'A-2', state: 'open' }),
  makeFinding({ id: 'A-3', state: 'open' }),
];
const [first, second, third] = queue as [FindingJson, FindingJson, FindingJson];

/** Runs an interaction and lets the write it starts settle inside act. */
async function settled(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}

/** Lets a write that was deliberately observed mid-flight finish inside act. */
async function settle(): Promise<void> {
  await settled(() => {});
}

function effectFor(finding: FindingJson, token = 'token-1'): unknown {
  return { finding, undoToken: token };
}

/**
 * A file another writer holds, released on demand: the retry is parked in its
 * wait, which is where the console is while the reader is looking at it.
 */
function heldOnce(): {
  fetch: ReturnType<typeof vi.fn>;
  api: { fetch: typeof globalThis.fetch; wait: () => Promise<void> };
  release: () => void;
} {
  let release = (): void => undefined;
  const call = vi
    .fn()
    .mockImplementationOnce(
      responds(503, { error: { code: 'locked', message: 'held', retryable: true } })
    )
    .mockImplementation(responds(200, effectFor(first)));
  return {
    fetch: call,
    api: {
      fetch: call as unknown as typeof globalThis.fetch,
      wait: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    },
    release: () => {
      release();
    },
  };
}

function setup(
  overrides: Partial<RulingActionsOptions> & { readonly fetch?: ReturnType<typeof vi.fn> } = {}
): {
  result: { current: ReturnType<typeof useRulingActions> };
  put: ReturnType<typeof vi.fn>;
  onFocus: ReturnType<typeof vi.fn>;
  onLand: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  unmount: () => void;
} {
  const put = vi.fn();
  const onFocus = vi.fn();
  const onLand = vi.fn();
  const notify = vi.fn();
  const fetchMock = overrides.fetch ?? vi.fn().mockImplementation(responds(200, effectFor(first)));
  const rest = { ...overrides };
  delete rest.fetch;
  // Built once, not per render: the store is what the hook subscribes to.
  const writeStore = overrides.writeStore ?? createWriteStore();
  const { result, unmount } = renderHook(
    () =>
      useRulingActions({
        queue,
        sectionState: 'open',
        put,
        onFocus,
        onLand,
        notify,
        // Every hook gets its own, so one test's write is not another's state.
        writeStore,
        api: {
          fetch: fetchMock as unknown as typeof globalThis.fetch,
          wait: () => Promise.resolve(),
        },
        ...rest,
      }),
    { wrapper: withAuditAddress }
  );
  return { result, put, onFocus, onLand, notify, fetchMock, unmount };
}

describe('nextInQueue', () => {
  it('steps forward', () => {
    expect(nextInQueue(queue, 'A-1')).toBe('A-2');
  });

  it('steps back at the end so the reader stays beside their work', () => {
    expect(nextInQueue(queue, 'A-3')).toBe('A-2');
  });

  it('has nowhere to go in a queue of one', () => {
    expect(nextInQueue([first], 'A-1')).toBeNull();
  });

  it('has nowhere to go for a finding the queue does not hold', () => {
    expect(nextInQueue(queue, 'ghost')).toBeNull();
  });
});

describe('useRulingActions', () => {
  it('posts the chosen option', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/audits/2026-07-30/finding/A-1/rule',
      expect.objectContaining({ body: JSON.stringify({ option: 'A', base: 'hash' }) })
    );
  });

  it('posts the note beside the option', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.rule(first, { option: 'A', note: 'ship it behind the flag' });
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'A', note: 'ship it behind the flag', base: 'hash' }),
    });
  });

  it('posts free text as its own ruling', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.rule(first, { option: 'other', text: 'do the third thing' });
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'other', text: 'do the third thing', base: 'hash' }),
    });
  });

  it('moves the finding out of the section before the server answers', async () => {
    const { result, put } = setup();

    act(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-1', state: 'ruled' }));
    await settle();
  });

  it('advances to the next finding in the queue', async () => {
    const { result, onFocus } = setup();

    act(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(onFocus).toHaveBeenCalledWith('A-2');
    await settle();
  });

  it('stays put when the ruling leaves the finding in this section', async () => {
    const { result, onFocus } = setup({ sectionState: 'ruled' });

    act(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(onFocus).not.toHaveBeenCalled();
    await settle();
  });

  it('leaves the reader where they are when the queue holds only this finding', async () => {
    const put = vi.fn();
    const onFocus = vi.fn();
    const { result } = renderHook(
      () =>
        useRulingActions({
          queue: [first],
          sectionState: 'open',
          put,
          onFocus,
          onLand: vi.fn(),
          notify: vi.fn(),
          api: {
            fetch: vi
              .fn()
              .mockImplementation(
                responds(200, effectFor(first))
              ) as unknown as typeof globalThis.fetch,
            wait: () => Promise.resolve(),
          },
        }),
      { wrapper: withAuditAddress }
    );

    act(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(onFocus).not.toHaveBeenCalled();
    await settle();
  });

  it('takes the server answer over the optimistic one', async () => {
    const answered = makeFinding({ id: 'A-1', state: 'ruled' });
    const { result, put } = setup({
      fetch: vi.fn().mockImplementation(responds(200, effectFor(answered))),
    });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(put).toHaveBeenLastCalledWith(answered);
  });

  it('offers the way back once the write lands', async () => {
    const { result, notify } = setup();

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(notify).toHaveBeenCalledWith('Ruled A-1 as A', expect.any(Function));
  });

  it('names free text rather than the option id in the undo message', async () => {
    const { result, notify } = setup();

    await settled(() => {
      result.current.rule(first, { option: 'other', text: 'do the third thing' });
    });

    expect(notify).toHaveBeenCalledWith('Ruled A-1', expect.any(Function));
  });

  it('has nothing to undo before the first write', () => {
    const { result } = setup();

    expect(result.current.canUndo).toBe(false);
  });

  it('can undo once a write has landed', async () => {
    const { result } = setup();

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(result.current.canUndo).toBe(true);
  });

  it('puts the finding back and lands on the finding the undo response returned', async () => {
    // Every other source disagrees with the response on purpose, so this can
    // only pass on the response: the write leaves A-1 `denied`, the pane holds
    // it `denied`, and only the undo's own answer knows it is `open` again.
    const postWrite = makeFinding({ id: 'A-1', state: 'denied' });
    const restored = makeFinding({ id: 'A-1', state: 'open' });
    const paneAfterWrite = [postWrite, second, third];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(200, effectFor(postWrite)))
      .mockImplementationOnce(responds(200, effectFor(restored, 'token-2')));
    const { result, put, onLand } = setup({ fetch: fetchMock, queue: paneAfterWrite });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });
    await settled(() => {
      result.current.undo();
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/undo');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ token: 'token-1' }),
    });
    expect(put).toHaveBeenLastCalledWith(restored);
    expect(onLand).toHaveBeenLastCalledWith(restored);
    // The two wrong sources, pinned so editing either one fires here rather than
    // silently making the assertion above agree with everything. `restored` is
    // not pinned: changing it to `denied` would go vacuous with both of these
    // still green.
    expect(paneAfterWrite.find((entry) => entry.id === 'A-1')?.state).toBe('denied');
    expect(postWrite.state).toBe('denied');
  });

  it('undoes the write its own toast was minted for, not the newest one', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(200, effectFor(first, 'token-first')))
      .mockImplementationOnce(responds(200, effectFor(second, 'token-second')))
      .mockImplementationOnce(responds(200, effectFor(first)));
    const notify = vi.fn();
    const { result } = setup({ fetch: fetchMock, notify });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });
    await settled(() => {
      result.current.deny(second, null);
    });
    // Both toasts are on screen: take the older one, the way a misclick is caught
    // a beat after the next finding has already been ruled.
    const undoTheFirst = notify.mock.calls[0]?.[1] as () => void;
    await settled(undoTheFirst);

    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/undo');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({ token: 'token-first' }),
    });
  });

  it('leaves the newer write undoable after an older toast is taken', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(200, effectFor(first, 'token-first')))
      .mockImplementationOnce(responds(200, effectFor(second, 'token-second')))
      .mockImplementationOnce(responds(200, effectFor(first)))
      .mockImplementationOnce(responds(200, effectFor(second)));
    const notify = vi.fn();
    const { result } = setup({ fetch: fetchMock, notify });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });
    await settled(() => {
      result.current.deny(second, null);
    });
    await settled(notify.mock.calls[0]?.[1] as () => void);

    expect(result.current.canUndo).toBe(true);

    await settled(() => {
      result.current.undo();
    });

    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      body: JSON.stringify({ token: 'token-second' }),
    });
  });

  it('ignores an undo with nothing behind it', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.undo();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores the card when the write is refused', async () => {
    const { result, put } = setup({
      fetch: vi
        .fn()
        .mockImplementation(
          responds(409, { error: { code: 'invalid-transition', message: 'already denied' } })
        ),
    });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(put).toHaveBeenLastCalledWith(first);
  });

  it('reports the refusal against the finding it failed on', async () => {
    const { result } = setup({
      fetch: vi
        .fn()
        .mockImplementation(
          responds(409, { error: { code: 'invalid-transition', message: 'already denied' } })
        ),
    });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(result.current.errorFor('A-1')).toBe('already denied');
    expect(result.current.errorFor('A-2')).toBeNull();
  });

  it('returns to the finding a refused write left behind', async () => {
    const { result, onFocus } = setup({
      fetch: vi.fn().mockImplementation(responds(500, { error: { message: 'disk gone' } })),
    });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(onFocus).toHaveBeenLastCalledWith('A-1');
  });

  it('offers no undo after a refused write', async () => {
    const { result, notify } = setup({
      fetch: vi.fn().mockImplementation(responds(500, { error: { message: 'disk gone' } })),
    });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(notify).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(false);
  });

  it('keeps a refusal that landed after the card had gone', async () => {
    const writeStore = createWriteStore();
    const refused = vi.fn().mockImplementation(responds(500, { error: { message: 'disk gone' } }));
    const gone = setup({ writeStore, fetch: refused });

    gone.result.current.rule(first, { option: 'A' });
    gone.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    const { result } = setup({ writeStore });

    expect(result.current.errorFor('A-1')).toBe('disk gone');
  });

  it('names the finding whose write is waiting on another writer', async () => {
    const held = heldOnce();
    const { result } = setup({ fetch: held.fetch, api: held.api });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(result.current.waitingOn).toEqual(['A-1']);
    await settled(held.release);
  });

  it('stops naming it once the write gets through', async () => {
    const held = heldOnce();
    const { result } = setup({ fetch: held.fetch, api: held.api });
    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    await settled(held.release);

    expect(result.current.waitingOn).toEqual([]);
  });

  it('names a finding once however many attempts report the same wait', async () => {
    const held = vi
      .fn()
      .mockImplementation(
        responds(503, { error: { code: 'locked', message: 'held', retryable: true } })
      );
    let release = (): void => undefined;
    let waits = 0;
    const { result } = setup({
      fetch: held,
      api: {
        fetch: held as unknown as typeof globalThis.fetch,
        // Parked on the second retry, which is one refusal after the first.
        wait: () => {
          waits += 1;
          return waits < 2
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                release = resolve;
              });
        },
      },
    });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(held).toHaveBeenCalledTimes(2);
    expect(result.current.waitingOn).toEqual(['A-1']);
    await settled(() => {
      release();
    });
  });

  it('names nothing while a write nobody is holding is in flight', async () => {
    const { result } = setup();

    result.current.rule(first, { option: 'A' });

    expect(result.current.waitingOn).toEqual([]);
    await settle();
  });

  it('clears a stale error when the reader tries again', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(500, { error: { message: 'disk gone' } }))
      .mockImplementationOnce(responds(200, effectFor(first)));
    const { result } = setup({ fetch: fetchMock });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });
    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });

    expect(result.current.errorFor('A-1')).toBeNull();
  });

  it('lands the reader on the finding a refused undo belongs to', async () => {
    // The server answers a write with the finding as the write left it, which
    // is what the undo token has to carry for the refusal branch.
    const ruled = makeFinding({ id: 'A-1', state: 'ruled' });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(200, effectFor(ruled)))
      .mockImplementationOnce(
        responds(404, { error: { code: 'not-found', message: 'unknown undo token' } })
      );
    const { result, onLand } = setup({ fetch: fetchMock });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });
    await settled(() => {
      result.current.undo();
    });

    // A refused undo leaves the finding in the state the write gave it, so the
    // reader is landed on it there rather than where the store last saw it.
    expect(onLand).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'A-1', state: 'ruled' }));
  });

  it('surfaces a refused undo', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(200, effectFor(first)))
      .mockImplementationOnce(
        responds(404, { error: { code: 'not-found', message: 'unknown undo token' } })
      );
    const { result } = setup({ fetch: fetchMock });

    await settled(() => {
      result.current.rule(first, { option: 'A' });
    });
    await settled(() => {
      result.current.undo();
    });

    expect(result.current.errorFor('A-1')).toBe('unknown undo token');
  });

  it('denies with a reason', async () => {
    const { result, fetchMock, put, notify } = setup();

    await settled(() => {
      result.current.deny(second, 'the audit misread the code');
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/A-2/deny');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ reason: 'the audit misread the code', base: 'hash' }),
    });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-2', state: 'denied' }));
    expect(notify).toHaveBeenCalledWith('Denied A-2', expect.any(Function));
  });

  it('denies without a reason', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.deny(second, null);
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ base: 'hash' }) });
  });

  it('asks a question without moving the finding, because a question decides nothing', async () => {
    const { result, fetchMock, put, notify } = setup();

    await settled(() => {
      result.current.ask(third, 'which pool does this run on?');
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/A-3/ask');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ text: 'which pool does this run on?' }),
    });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-3', state: 'open' }));
    expect(notify).toHaveBeenCalledWith('Asked about A-3', expect.any(Function));
  });

  it('answers a block without disturbing the ruling that stands', async () => {
    const { result, fetchMock, put, notify } = setup();

    await settled(() => {
      result.current.unblock(third, 'the pool is owned by the api slice');
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/A-3/unblock');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ note: 'the pool is owned by the api slice', base: 'hash' }),
    });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-3', state: 'open' }));
    expect(notify).toHaveBeenCalledWith('Unblocked A-3', expect.any(Function));
  });
});

describe('the dedicated mark', () => {
  it('posts the mark on its own', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.dedicate(first, true);
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/A-1/dedicate');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ dedicated: true, base: 'hash' }),
    });
  });

  it('posts the mark being cleared', async () => {
    const marked = makeFinding({ id: 'A-1', state: 'open', dedicated: true });
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.dedicate(marked, false);
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ dedicated: false, base: 'hash' }),
    });
  });

  it('leaves the reader on the finding, because a mark is not a decision', async () => {
    const { result, onFocus, notify } = setup();

    await settled(() => {
      result.current.dedicate(first, true);
    });

    expect(onFocus).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'Marked A-1 for a session of its own',
      expect.any(Function)
    );
  });

  it('says so when the mark comes off', async () => {
    const { result, notify } = setup();

    await settled(() => {
      result.current.dedicate(first, false);
    });

    expect(notify).toHaveBeenCalledWith('Cleared the mark on A-1', expect.any(Function));
  });

  it('carries a mark on the ruling that decided it', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.rule(first, { option: 'A', dedicated: true });
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'A', dedicated: true, base: 'hash' }),
    });
  });

  it('leaves the mark off a ruling that would not change it', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.rule(first, { option: 'A', dedicated: false });
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'A', base: 'hash' }),
    });
  });

  it('carries a mark on the answer to a block', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.unblock(third, 'agreed, it needs a session', true);
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        note: 'agreed, it needs a session',
        dedicated: true,
        base: 'hash',
      }),
    });
  });

  it('leaves the mark off an answer that would not change it', async () => {
    const { result, fetchMock } = setup();

    await settled(() => {
      result.current.unblock(third, 'carry on', false);
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ note: 'carry on', base: 'hash' }),
    });
  });
});

/**
 * The Dedicated queue is not a state's queue: its spec carries `open` only as
 * the yardstick a write is measured against, exactly as the Questions spec
 * does, and membership is the mark. So a ruling taken here moves the reader on
 * while the finding it ruled stays in the queue — a ruling settles what the
 * session will do, and does not undedicate anything.
 */
describe('a ruling taken in the Dedicated queue', () => {
  const marked: readonly FindingJson[] = [
    makeFinding({ id: 'D-1', state: 'open', dedicated: true }),
    makeFinding({ id: 'D-2', state: 'open', dedicated: true }),
  ];
  const [head, next] = marked as [FindingJson, FindingJson];

  function inDedicated(): ReturnType<typeof setup> {
    return setup({
      queue: marked,
      sectionState: sectionSpec('dedicated').state,
      fetch: vi.fn().mockImplementation(responds(200, effectFor({ ...head, state: 'ruled' }))),
    });
  }

  it('keeps the ruled finding in the queue it was ruled from', async () => {
    const { result, put } = inDedicated();

    await settled(() => {
      result.current.rule(head, { option: 'A' });
    });

    const ruled = put.mock.calls.at(-1)?.[0] as FindingJson;
    expect(sectionSpec('dedicated').holds(ruled)).toBe(true);
  });

  it('moves the reader on to the next finding owed a session', async () => {
    const { result, onFocus } = inDedicated();

    await settled(() => {
      result.current.rule(head, { option: 'A' });
    });

    expect(onFocus).toHaveBeenCalledWith(next.id);
  });

  it('puts the reader back on the finding when the ruling is refused', async () => {
    const { result, onFocus, put } = setup({
      queue: marked,
      sectionState: sectionSpec('dedicated').state,
      fetch: vi.fn().mockImplementation(responds(409, { error: { code: 'conflict' } })),
    });

    await settled(() => {
      result.current.rule(head, { option: 'A' });
    });

    expect(onFocus).toHaveBeenLastCalledWith(head.id);
    expect(put).toHaveBeenLastCalledWith(head);
  });
});

/**
 * What a write leaves behind outlives every mount that could clear it, and
 * finding ids are chosen per audit — so two audits can name a finding the same
 * way, and one audit's undo, refusal or wait must never be offered on the
 * other's card. Each test names its own pair of audits, because what these
 * read is the console's own store rather than one built for the test.
 */
describe('useRulingActions across audits', () => {
  function auditWrapper(audit: string): (props: Readonly<{ children: ReactNode }>) => JSX.Element {
    return function Addressed({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
      return createElement(AuditAddressProvider, { audit: audit, children: children });
    };
  }

  /** Deliberately without a `writeStore`: the console's own is what is under test. */
  function setupIn(
    audit: string,
    fetchMock: ReturnType<typeof vi.fn> = vi
      .fn()
      .mockImplementation(responds(200, effectFor(first))),
    wait: () => Promise<void> = () => Promise.resolve()
  ): {
    result: { current: ReturnType<typeof useRulingActions> };
    fetchMock: ReturnType<typeof vi.fn>;
    unmount: () => void;
  } {
    const { result, unmount } = renderHook(
      () =>
        useRulingActions({
          queue,
          sectionState: 'open',
          put: vi.fn(),
          onFocus: vi.fn(),
          onLand: vi.fn(),
          notify: vi.fn(),
          api: { fetch: fetchMock as unknown as typeof globalThis.fetch, wait: wait },
        }),
      { wrapper: auditWrapper(audit) }
    );
    return { result, fetchMock, unmount };
  }

  it('cannot take back a write made in another audit', async () => {
    const made = setupIn('2026-01-01');
    await settled(() => {
      made.result.current.rule(first, { option: 'A' });
    });
    made.unmount();

    const elsewhere = setupIn('2026-01-02');
    act(() => {
      elsewhere.result.current.undo();
    });

    expect(elsewhere.result.current.canUndo).toBe(false);
    expect(elsewhere.fetchMock).not.toHaveBeenCalled();
  });

  it('still offers back the write made in the audit the reader returns to', async () => {
    const inFirst = vi.fn().mockImplementation(responds(200, effectFor(first, 'token-first')));
    const made = setupIn('2026-02-01', inFirst);
    await settled(() => {
      made.result.current.rule(first, { option: 'A' });
    });
    made.unmount();
    const inSecond = vi.fn().mockImplementation(responds(200, effectFor(second, 'token-second')));
    const elsewhere = setupIn('2026-02-02', inSecond);
    await settled(() => {
      elsewhere.result.current.rule(second, { option: 'A' });
    });
    elsewhere.unmount();

    const back = setupIn('2026-02-01', inFirst);
    expect(back.result.current.canUndo).toBe(true);
    await settled(() => {
      back.result.current.undo();
    });

    expect(inFirst.mock.calls.at(-1)?.[0]).toBe('/api/undo');
    expect(inFirst.mock.calls.at(-1)?.[1]).toMatchObject({
      body: JSON.stringify({ token: 'token-first' }),
    });
  });

  it('never reports one audit’s refusal on the same finding in another', async () => {
    const refused = vi.fn().mockImplementation(responds(500, { error: { message: 'disk gone' } }));
    const made = setupIn('2026-03-01', refused);
    await settled(() => {
      made.result.current.deny(first, null);
    });
    expect(made.result.current.errorFor('A-1')).toBe('disk gone');
    made.unmount();

    const elsewhere = setupIn('2026-03-02');

    expect(elsewhere.result.current.errorFor('A-1')).toBeNull();
  });

  it('never reports the write one audit is waiting on as another’s', async () => {
    const held = heldOnce();
    const waiting = setupIn('2026-04-01', held.fetch, held.api.wait);
    await settled(() => {
      waiting.result.current.rule(first, { option: 'A' });
    });
    expect(waiting.result.current.waitingOn).toEqual(['A-1']);

    const elsewhere = setupIn('2026-04-02');

    expect(elsewhere.result.current.waitingOn).toEqual([]);
    await settled(held.release);
  });
});
