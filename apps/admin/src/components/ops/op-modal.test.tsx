import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { buttonRowClass } from '@hushbox/ui/button-groups';
import { TEST_IDS, TEST_ID_BUILDERS, TOUCH_QUERY } from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { requestUrl } from '@/test-utils/request-url';
import { opCatalogEntry } from '@/test-utils/op-catalog';
import { OpModal } from './op-modal.js';
import type { AdminOpWire } from '@hushbox/shared';
import type { OpFormValues } from '@/lib/op-fields';

const ORIGINAL_MATCH_MEDIA = globalThis.matchMedia;

/** Stubs `matchMedia` for a window `width` wide with the given primary pointer. */
function installWidth(width: number, pointer: 'fine' | 'coarse' = 'fine'): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query)?.[1];
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches:
          maxWidth === undefined
            ? query === TOUCH_QUERY && pointer === 'coarse'
            : width <= Number(maxWidth),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // The band and pointer hooks read only `matches` and the listener pair.
      return list as MediaQueryList;
    },
  });
}

/** The element a step's action sits in. */
function rowOf(button: HTMLElement): HTMLElement {
  const row = button.parentElement;
  if (row === null) throw new Error('the button has no parent');
  return row;
}

/** The names a module imports from the root `@hushbox/ui` barrel. */
function rootUiImports(source: string): string[] {
  return [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@hushbox\/ui';/g)].flatMap(
    (match) =>
      (match[1] ?? '')
        .split(',')
        .map((name) => name.trim().replace(/^type\s+/, ''))
        .filter((name) => name !== '')
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPS: readonly AdminOpWire[] = [
  opCatalogEntry('wallet.credit'),
  opCatalogEntry('wallet.clawback'),
];

/**
 * A catalog entry for an op the shared contracts do not carry — the one case
 * in which the modal builds a form from the wire's `fields` list instead of a
 * bundled contract's Zod input.
 */
const FUTURE_OP: AdminOpWire = {
  name: 'future.op',
  title: 'Future op',
  kind: 'mutation',
  effectClass: 'ephemeral',
  inverse: null,
  fields: ['targetId', 'reason'],
};

const UUID = '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40';
const AUDIT_ID = testUuidV7(1);

interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function stubOpsFetch(handlers: {
  preview?: (req: RecordedRequest) => Response;
  execute?: (req: RecordedRequest) => Response | Promise<Response>;
}): { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const req: RecordedRequest = {
        url,
        headers: new Headers(init?.headers),
        body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      };
      calls.push(req);
      if (url.includes('/preview')) {
        return Promise.resolve(
          handlers.preview?.(req) ??
            Response.json({
              effects: [{ label: 'wallet.balanceNanoUsd', before: '0', after: '5000000000' }],
              inverseInput: { walletId: UUID, amountNanoUsd: '5000000000', reason: 'undo credit' },
            })
        );
      }
      if (url.includes('/execute')) {
        return Promise.resolve(
          handlers.execute?.(req) ??
            Response.json({
              auditId: AUDIT_ID,
              effects: [{ label: 'wallet.balanceNanoUsd', before: '0', after: '5000000000' }],
              inverseInput: { walletId: UUID, amountNanoUsd: '5000000000', reason: 'undo credit' },
            })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
  return { calls };
}

function renderModal(onClose = vi.fn()): {
  onClose: ReturnType<typeof vi.fn>;
  client: QueryClient;
} {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModal ops={OPS} start={{ opName: 'wallet.credit' }} onClose={onClose} />
    </QueryClientProvider>
  );
  return { onClose, client };
}

function renderSeededModal(initialValues: OpFormValues): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModal ops={OPS} start={{ opName: 'wallet.credit', initialValues }} onClose={vi.fn()} />
    </QueryClientProvider>
  );
}

async function fillAndPreview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('walletId'), UUID);
  await user.type(screen.getByLabelText('amountNanoUsd'), '5000000000');
  await user.type(screen.getByLabelText('reason'), 'test credit');
  await user.click(screen.getByRole('button', { name: 'Preview changes' }));
}

describe('OpModal', () => {
  // Regression guard for the reorder+prepend hang: a tall op form (repeatable
  // groups grow unbounded) must scroll inside the centered fixed dialog, or the
  // submit button falls below the fold and becomes unreachable — no window
  // scroll can reach a fixed element's overflow. jsdom has no layout, so this
  // asserts the affordance; the banner e2e's reorder leg is the behavioral net.
  it('caps its height and scrolls internally so a tall form stays reachable', () => {
    stubOpsFetch({});
    renderModal();
    const modal = screen.getByTestId(TEST_IDS.adminOpModal);
    expect(modal.className).toContain('overflow-y-auto');
    expect(modal.className).toMatch(/max-h-\[/);
  });

  it('invalidates the admin query-key root after a successful execute', async () => {
    const user = userEvent.setup();
    stubOpsFetch({});
    const { client } = renderModal();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    expect(invalidate).not.toHaveBeenCalled();
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin'] });
  });

  it('does not invalidate admin queries when the execute fails', async () => {
    const user = userEvent.setup();
    stubOpsFetch({
      execute: () => Response.json({ code: 'GUARDRAIL_VIOLATION' }, { status: 422 }),
    });
    const { client } = renderModal();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpError)).toBeInTheDocument();
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('opens on the form step with the op title', () => {
    stubOpsFetch({});
    renderModal();
    expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Credit wallet' })).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminOpForm)).toBeInTheDocument();
  });

  it('renders a blank reason when the flow is seeded with one', () => {
    stubOpsFetch({});
    renderSeededModal({ walletId: UUID, reason: 'seeded by a screen' });

    expect(screen.getByLabelText('reason')).toHaveValue('');
  });

  it('keeps a seeded value whose field is not reason', () => {
    stubOpsFetch({});
    renderSeededModal({ walletId: UUID, reason: 'seeded by a screen' });

    expect(screen.getByLabelText('walletId')).toHaveValue(UUID);
  });

  it('previews on submit and labels execute with the consequence, never Confirm', async () => {
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    renderModal();

    await fillAndPreview(user);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpDiff)).toBeInTheDocument();
    });
    expect(calls[0]?.url).toContain('/api/admin/ops/wallet.credit/preview');
    expect(calls[0]?.body).toEqual({
      input: { walletId: UUID, amountNanoUsd: '5000000000', reason: 'test credit' },
    });
    const execute = screen.getByTestId(TEST_IDS.adminOpExecute);
    expect(execute).toHaveTextContent('Credit wallet (1 change)');
    expect(execute).not.toHaveTextContent('Confirm');
  });

  it('blocks at the preview step on a guardrail refusal', async () => {
    const user = userEvent.setup();
    stubOpsFetch({
      preview: () => Response.json({ code: 'GUARDRAIL_EXCEEDED' }, { status: 422 }),
    });
    renderModal();

    await fillAndPreview(user);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpError)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.adminOpError)).toHaveTextContent('GUARDRAIL_EXCEEDED');
    expect(screen.queryByTestId(TEST_IDS.adminOpExecute)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to form' }));
    expect(screen.getByTestId(TEST_IDS.adminOpForm)).toBeInTheDocument();
    expect(screen.getByLabelText('walletId')).toHaveValue(UUID);
    expect(screen.getByLabelText('reason')).toHaveValue('test credit');
  });

  it('preserves group rows and booleans across a back-to-form round trip', async () => {
    const user = userEvent.setup();
    stubOpsFetch({
      preview: () => Response.json({ code: 'GUARDRAIL_EXCEEDED' }, { status: 422 }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const bannerOps: readonly AdminOpWire[] = [opCatalogEntry('banner.set')];
    render(
      <QueryClientProvider client={client}>
        <OpModal ops={bannerOps} start={{ opName: 'banner.set' }} onClose={vi.fn()} />
      </QueryClientProvider>
    );

    await user.click(screen.getByRole('switch', { name: 'enabled' }));
    const row = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 0));
    await user.click(within(row).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(within(row).getByLabelText('text'), 'Maintenance at noon');
    await user.type(screen.getByLabelText('reason'), 'round trip');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(await screen.findByRole('button', { name: 'Back to form' }));

    expect(screen.getByRole('switch', { name: 'enabled' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    const restoredRow = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 0));
    expect(within(restoredRow).getByLabelText('text')).toHaveValue('Maintenance at noon');
  });

  it('executes with an Idempotency-Key and shows the audit id with a copy affordance', async () => {
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.adminOpAuditId)).toHaveTextContent(AUDIT_ID);
    const executeCall = calls.find((call) => call.url.includes('/execute'));
    expect(executeCall?.headers.get('Idempotency-Key')).toMatch(/[0-9a-f-]{36}/);

    await user.click(screen.getByTestId(TEST_IDS.adminOpCopyAudit));
    expect(writeText).toHaveBeenCalledWith(AUDIT_ID);
  });

  it('reuses the same Idempotency-Key when retrying a failed execute', async () => {
    const user = userEvent.setup();
    let executeAttempts = 0;
    const { calls } = stubOpsFetch({
      execute: () => {
        executeAttempts += 1;
        if (executeAttempts === 1) {
          return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
        }
        return Response.json({ auditId: AUDIT_ID, effects: [], inverseInput: null });
      },
    });
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpError)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    const executeCalls = calls.filter((call) => call.url.includes('/execute'));
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[0]?.headers.get('Idempotency-Key')).toBe(
      executeCalls[1]?.headers.get('Idempotency-Key')
    );
  });

  it('mints a fresh Idempotency-Key for a new form submission', async () => {
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    const firstKey = calls
      .find((call) => call.url.includes('/execute'))
      ?.headers.get('Idempotency-Key');

    // Undo starts a NEW submission of the inverse op: new form, new key.
    await user.click(screen.getByTestId(TEST_IDS.adminOpUndo));
    expect(screen.getByRole('heading', { name: 'Claw back wallet credit' })).toBeInTheDocument();
    expect(screen.getByLabelText('reason')).toHaveValue('');
    await user.type(screen.getByLabelText('reason'), 'credit was a mistake');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    const executeCalls = calls.filter((call) => call.url.includes('/execute'));
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[1]?.url).toContain('/api/admin/ops/wallet.clawback/execute');
    expect(executeCalls[1]?.body).toMatchObject({ undoes: AUDIT_ID });
    expect(executeCalls[1]?.headers.get('Idempotency-Key')).not.toBe(firstKey);
  });

  it('submits an undo with the recorded inverse input unchanged beside the typed reason', async () => {
    // The engine refuses an undo whose input differs in any field but
    // `reason` from the recorded `inverseInput`, so the prefill → form →
    // submit round trip must reproduce that JSON exactly; a lossy control (a
    // coerced number, a dropped optional) would 409 every legitimate undo.
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(TEST_IDS.adminOpUndo));
    await user.type(screen.getByLabelText('reason'), 'customer disputed the credit');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    const executeCalls = calls.filter((call) => call.url.includes('/execute'));
    expect(executeCalls[1]?.body).toEqual({
      input: {
        walletId: UUID,
        amountNanoUsd: '5000000000',
        reason: 'customer disputed the credit',
      },
      undoes: AUDIT_ID,
    });
  });

  it('blocks an undo submitted with a blank reason before any preview request', async () => {
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    const callsBeforeUndo = calls.length;

    await user.click(screen.getByTestId(TEST_IDS.adminOpUndo));
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(screen.getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
    expect(screen.getByTestId(TEST_IDS.adminOpForm)).toBeInTheDocument();
    expect(calls).toHaveLength(callsBeforeUndo);
  });

  it('previews an undo with its undoes so the dry run validates the undo target', async () => {
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    expect(calls[0]?.body).not.toHaveProperty('undoes');
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(TEST_IDS.adminOpUndo));
    await user.type(screen.getByLabelText('reason'), 'reversing the credit');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });

    const previewCalls = calls.filter((call) => call.url.includes('/preview'));
    expect(previewCalls[1]?.url).toContain('/api/admin/ops/wallet.clawback/preview');
    expect(previewCalls[1]?.body).toEqual({
      input: {
        walletId: UUID,
        amountNanoUsd: '5000000000',
        reason: 'reversing the credit',
      },
      undoes: AUDIT_ID,
    });
  });

  it('shows the generic error for a non-API failure at preview', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down')))
    );
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpError)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.adminOpError)).toHaveTextContent('INTERNAL');
  });

  it('titles the modal with the op name for a flow the catalog does not carry', () => {
    stubOpsFetch({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModal ops={[FUTURE_OP]} start={{ opName: 'mystery.op' }} onClose={vi.fn()} />
      </QueryClientProvider>
    );
    expect(screen.getByRole('heading', { name: 'mystery.op' })).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminOpForm)).toBeInTheDocument();
  });

  it('builds the form from the wire field list for an op missing from the shared contracts', () => {
    stubOpsFetch({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModal ops={[FUTURE_OP]} start={{ opName: FUTURE_OP.name }} onClose={vi.fn()} />
      </QueryClientProvider>
    );
    expect(screen.getAllByRole('textbox').map((input) => input.getAttribute('name'))).toEqual([
      'targetId',
      'reason',
    ]);
  });

  it("states a system-owned op's case for having no undo, before the operator runs it", () => {
    stubOpsFetch({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModal
          ops={[opCatalogEntry('job.redrive')]}
          start={{ opName: 'job.redrive' }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );
    // The form step: the operator has not previewed, let alone executed.
    expect(screen.getByTestId(TEST_IDS.adminOpForm)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminOpModal)).toHaveTextContent(
      'resumes at-least-once work the system already owed'
    );
  });

  it("words a system-owned op's no-undo note as two sentences", () => {
    stubOpsFetch({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModal
          ops={[opCatalogEntry('job.redrive')]}
          start={{ opName: 'job.redrive' }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );
    const reason = opCatalogEntry('job.redrive').systemOwnedReason;
    if (reason === undefined) throw new Error('job.redrive states no system-owned reason');

    expect(screen.getByText(/^No undo/).textContent).toBe(
      `No undo. The effect is the system's own, not the operator's: ${reason}`
    );
  });

  it('states no such case for an op of another class', () => {
    stubOpsFetch({});
    renderModal();

    expect(screen.getByTestId(TEST_IDS.adminOpModal)).not.toHaveTextContent('No undo');
  });

  it("closes through the overlay's close button", async () => {
    const user = userEvent.setup();
    stubOpsFetch({});
    const { onClose } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('closes through the Done button', async () => {
    const user = userEvent.setup();
    stubOpsFetch({});
    const onClose = vi.fn();
    renderModal(onClose);

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  describe('while the execute request is pending', () => {
    afterEach(() => {
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        value: ORIGINAL_MATCH_MEDIA,
      });
    });

    /** Stubs the API with an execute answer held until the returned function releases it. */
    function holdExecute(): { calls: RecordedRequest[]; release: () => void } {
      let release: () => void = () => {
        throw new Error('the execute request was never sent');
      };
      const held = new Promise<Response>((resolve) => {
        release = (): void => {
          resolve(Response.json({ auditId: AUDIT_ID, effects: [], inverseInput: null }));
        };
      });
      const { calls } = stubOpsFetch({ execute: () => held });
      return {
        calls,
        release: () => {
          release();
        },
      };
    }

    // Keyboard only: a pointer release inside the bottom sheet runs vaul's drag math, which
    // reads a computed transform happy-dom does not provide.
    async function previewByKeyboard(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      const typed: readonly (readonly [string, string])[] = [
        ['walletId', UUID],
        ['amountNanoUsd', '5000000000'],
        ['reason', 'test credit'],
      ];
      for (const [label, value] of typed) {
        screen.getByLabelText(label).focus();
        await user.keyboard(value);
      }
      screen.getByRole('button', { name: 'Preview changes' }).focus();
      await user.keyboard('{Enter}');
      await screen.findByTestId(TEST_IDS.adminOpExecute);
    }

    async function startExecute(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await previewByKeyboard(user);
      const execute = screen.getByTestId(TEST_IDS.adminOpExecute);
      execute.focus();
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeDisabled();
      });
    }

    it.each([
      { presentation: 'dialog', width: 1440 },
      { presentation: 'bottom sheet', width: 390 },
    ])('ignores Escape as a $presentation', async ({ width }) => {
      installWidth(width);
      const user = userEvent.setup();
      const { release } = holdExecute();
      const { onClose } = renderModal();
      await startExecute(user);

      await user.keyboard('{Escape}');

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
      release();
      expect(await screen.findByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    it.each([
      { presentation: 'dialog', width: 1440 },
      { presentation: 'bottom sheet', width: 390 },
    ])('offers no close button as a $presentation', async ({ width }) => {
      installWidth(width);
      const user = userEvent.setup();
      const { release } = holdExecute();
      renderModal();
      await startExecute(user);

      expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
      release();
      await screen.findByTestId(TEST_IDS.adminOpResult);
    });

    /** Presses Escape where the overlay's key listener hears it, with no act flush of its own. */
    function pressEscape(): void {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    }

    // One act scope renders nothing until it exits, so the close attempt lands after the
    // click's handler ran and before the pending state re-rendered the overlay.
    it.each([
      { presentation: 'dialog', width: 1440 },
      { presentation: 'bottom sheet', width: 390 },
    ])(
      'ignores an Escape in the same tick as the Execute click as a $presentation',
      async ({ width }) => {
        installWidth(width);
        const user = userEvent.setup();
        const { calls, release } = holdExecute();
        const { onClose } = renderModal();
        await previewByKeyboard(user);

        act(() => {
          screen.getByTestId(TEST_IDS.adminOpExecute).click();
          pressEscape();
        });

        expect(onClose).not.toHaveBeenCalled();
        await waitFor(() => {
          expect(calls.filter((call) => call.url.includes('/execute'))).toHaveLength(1);
        });
        release();
        expect(await screen.findByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
      }
    );

    it.each([
      { presentation: 'dialog', width: 1440 },
      { presentation: 'bottom sheet', width: 390 },
    ])(
      'ignores the close button in the same tick as the Execute click as a $presentation',
      async ({ width }) => {
        installWidth(width);
        const user = userEvent.setup();
        const { release } = holdExecute();
        const { onClose } = renderModal();
        await previewByKeyboard(user);

        act(() => {
          screen.getByTestId(TEST_IDS.adminOpExecute).click();
          screen.getByRole('button', { name: 'Close' }).click();
        });

        expect(onClose).not.toHaveBeenCalled();
        release();
        expect(await screen.findByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
      }
    );

    it('disables Back to form while the request runs', async () => {
      const user = userEvent.setup();
      const { release } = holdExecute();
      renderModal();
      await startExecute(user);

      expect(screen.getByRole('button', { name: 'Back to form' })).toBeDisabled();
      release();
      await screen.findByTestId(TEST_IDS.adminOpResult);
    });

    it('keeps the preview when Back to form is pressed while the request runs', async () => {
      const user = userEvent.setup();
      const { release } = holdExecute();
      renderModal();
      await startExecute(user);

      fireEvent.click(screen.getByRole('button', { name: 'Back to form' }));

      expect(screen.queryByTestId(TEST_IDS.adminOpForm)).toBeNull();
      release();
      expect(await screen.findByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    it('keeps the preview when Back to form is pressed in the same tick as the Execute click', async () => {
      const user = userEvent.setup();
      const { calls, release } = holdExecute();
      renderModal();
      await previewByKeyboard(user);

      act(() => {
        screen.getByTestId(TEST_IDS.adminOpExecute).click();
        screen.getByRole('button', { name: 'Back to form' }).click();
      });

      expect(screen.queryByTestId(TEST_IDS.adminOpForm)).toBeNull();
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
      await waitFor(() => {
        expect(calls.filter((call) => call.url.includes('/execute'))).toHaveLength(1);
      });
      release();
      expect(await screen.findByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    it('enables Back to form again once the request fails', async () => {
      const user = userEvent.setup();
      stubOpsFetch({
        execute: () => Response.json({ code: 'UNAVAILABLE' }, { status: 503 }),
      });
      renderModal();
      await previewByKeyboard(user);
      const execute = screen.getByTestId(TEST_IDS.adminOpExecute);
      execute.focus();
      await user.keyboard('{Enter}');
      await screen.findByTestId(TEST_IDS.adminOpError);

      expect(screen.getByRole('button', { name: 'Back to form' })).toBeEnabled();
    });

    type HeldState =
      | 'form'
      | 'preview'
      | 'pending'
      | 'pending after Back to form'
      | 'result'
      | 'failed';

    /** Brings the modal to one state; `finish` lets a held request settle and waits for it. */
    async function reach(
      state: HeldState,
      user: ReturnType<typeof userEvent.setup>
    ): Promise<{ onClose: ReturnType<typeof vi.fn>; finish: () => Promise<void> }> {
      const held = state === 'failed' ? null : holdExecute();
      if (held === null) {
        stubOpsFetch({ execute: () => Response.json({ code: 'UNAVAILABLE' }, { status: 503 }) });
      }
      const running = state === 'pending' || state === 'pending after Back to form';
      const finish = async (): Promise<void> => {
        if (!running || held === null) return;
        held.release();
        await screen.findByTestId(TEST_IDS.adminOpResult);
      };
      const { onClose } = renderModal();
      if (state === 'form') return { onClose, finish };
      await previewByKeyboard(user);
      if (state === 'preview') return { onClose, finish };
      const execute = screen.getByTestId(TEST_IDS.adminOpExecute);
      execute.focus();
      await user.keyboard('{Enter}');
      if (state === 'failed') {
        await screen.findByTestId(TEST_IDS.adminOpError);
        return { onClose, finish };
      }
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeDisabled();
      });
      if (state === 'pending after Back to form') {
        fireEvent.click(screen.getByRole('button', { name: 'Back to form' }));
      }
      if (state === 'result' && held !== null) {
        held.release();
        await screen.findByTestId(TEST_IDS.adminOpResult);
      }
      return { onClose, finish };
    }

    it.each<HeldState>([
      'form',
      'preview',
      'pending',
      'pending after Back to form',
      'result',
      'failed',
    ])('shows a close button in the %s state exactly when it accepts a close', async (state) => {
      const user = userEvent.setup();
      const { onClose, finish } = await reach(state, user);
      const offered = screen.queryAllByRole('button', { name: 'Close' }).length === 1;

      await user.keyboard('{Escape}');

      expect(onClose.mock.calls.length > 0).toBe(offered);
      await finish();
    });

    it('sends the execute request once and lets it finish', async () => {
      const user = userEvent.setup();
      const { calls, release } = holdExecute();
      renderModal();
      await startExecute(user);
      await user.keyboard('{Escape}');

      release();

      expect(await screen.findByTestId(TEST_IDS.adminOpAuditId)).toHaveTextContent(AUDIT_ID);
      expect(calls.filter((call) => call.url.includes('/execute'))).toHaveLength(1);
    });

    it('closes on Escape again once the request settles', async () => {
      const user = userEvent.setup();
      const { release } = holdExecute();
      const { onClose } = renderModal();
      await startExecute(user);
      release();
      await screen.findByTestId(TEST_IDS.adminOpResult);

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
    });

    it('closes through the close button again once the request settles', async () => {
      const user = userEvent.setup();
      const { release } = holdExecute();
      const { onClose } = renderModal();
      await startExecute(user);
      release();
      await screen.findByTestId(TEST_IDS.adminOpResult);

      await user.click(screen.getByRole('button', { name: 'Close' }));

      expect(onClose).toHaveBeenCalled();
    });

    it('closes again once the request fails', async () => {
      const user = userEvent.setup();
      stubOpsFetch({
        execute: () => Response.json({ code: 'UNAVAILABLE' }, { status: 503 }),
      });
      const { onClose } = renderModal();
      await fillAndPreview(user);
      await user.click(await screen.findByTestId(TEST_IDS.adminOpExecute));
      await screen.findByTestId(TEST_IDS.adminOpError);

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('on the shared overlay', () => {
    afterEach(() => {
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        value: ORIGINAL_MATCH_MEDIA,
      });
    });

    it('opens as a centred dialog from 768 wide', () => {
      installWidth(768);
      stubOpsFetch({});
      renderModal();
      expect(document.querySelector('[data-overlay-variant="dialog"]')).toContainElement(
        screen.getByTestId(TEST_IDS.adminOpModal)
      );
    });

    it('focuses the first field on open from 768 wide with a fine pointer', async () => {
      installWidth(1440);
      stubOpsFetch({});
      renderModal();

      await waitFor(() => {
        expect(screen.getByLabelText('walletId')).toHaveFocus();
      });
    });

    it('focuses the first tabbable control when the form opens on a switch', async () => {
      installWidth(1440);
      stubOpsFetch({});
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <OpModal
            ops={[opCatalogEntry('banner.set')]}
            start={{ opName: 'banner.set' }}
            onClose={vi.fn()}
          />
        </QueryClientProvider>
      );

      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'enabled' })).toHaveFocus();
      });
    });

    it('keeps focus off the fields on open below 768 wide', async () => {
      installWidth(390);
      stubOpsFetch({});
      renderModal();

      await waitFor(() => {
        expect(document.activeElement?.closest('[data-overlay-variant]')).not.toBeNull();
      });
      expect(screen.getByLabelText('walletId')).not.toHaveFocus();
    });

    it('keeps focus off the fields on open from 768 wide with a coarse pointer', async () => {
      installWidth(834, 'coarse');
      stubOpsFetch({});
      renderModal();

      await waitFor(() => {
        expect(document.activeElement?.closest('[data-overlay-variant]')).not.toBeNull();
      });
      expect(screen.getByLabelText('walletId')).not.toHaveFocus();
    });

    it('opens as a bottom sheet below 768 wide', () => {
      installWidth(767);
      stubOpsFetch({});
      renderModal();
      expect(document.querySelector('[data-overlay-variant="bottom-sheet"]')).toContainElement(
        screen.getByTestId(TEST_IDS.adminOpModal)
      );
    });
  });

  it("lays out the form step's action in a button row", () => {
    stubOpsFetch({});
    renderModal();

    expect(rowOf(screen.getByRole('button', { name: 'Preview changes' })).className).toBe(
      buttonRowClass
    );
  });

  it("lays out the preview step's actions in one button row", async () => {
    const user = userEvent.setup();
    stubOpsFetch({});
    renderModal();
    await fillAndPreview(user);
    const row = rowOf(await screen.findByTestId(TEST_IDS.adminOpExecute));

    expect(row.className).toBe(buttonRowClass);
    expect(row).toContainElement(screen.getByRole('button', { name: 'Back to form' }));
  });

  it("lays out the result step's actions in one button row", async () => {
    const user = userEvent.setup();
    stubOpsFetch({});
    renderModal();
    await fillAndPreview(user);
    await user.click(await screen.findByTestId(TEST_IDS.adminOpExecute));
    const row = rowOf(await screen.findByTestId(TEST_IDS.adminOpUndo));

    expect(row.className).toBe(buttonRowClass);
    expect(row).toContainElement(screen.getByRole('button', { name: 'Done' }));
  });

  it('lets a long execute label wrap inside its button rather than overflow it', async () => {
    const user = userEvent.setup();
    stubOpsFetch({});
    renderModal();
    await fillAndPreview(user);

    expect(await screen.findByTestId(TEST_IDS.adminOpExecute)).toHaveAttribute('data-block');
  });

  it('shows a refused preview as a destructive notice', async () => {
    const user = userEvent.setup();
    stubOpsFetch({
      preview: () => Response.json({ code: 'GUARDRAIL_EXCEEDED' }, { status: 422 }),
    });
    renderModal();
    await fillAndPreview(user);
    const notice = await screen.findByTestId(TEST_IDS.adminOpError);

    expect(notice).toHaveAttribute('data-slot', 'notice');
    expect(notice.className.split(' ')).toContain('bg-destructive/10');
  });

  it("draws a system-owned op's note without a side stripe", () => {
    stubOpsFetch({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModal
          ops={[opCatalogEntry('job.redrive')]}
          start={{ opName: 'job.redrive' }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );
    const note = screen.getByText(/resumes at-least-once work/);

    expect(note.className.split(' ').filter((token) => token.startsWith('border-l'))).toEqual([]);
  });

  it('imports none of the withdrawn primitives into the op modal files', () => {
    const withdrawn = /^(Dialog\w*|Input|Label|Select\w*|Switch|Badge)$/;
    const imported = ['op-modal.tsx', 'op-form.tsx', 'diff-list.tsx'].flatMap((file) =>
      rootUiImports(readFileSync(path.join(import.meta.dirname, file), 'utf8'))
    );

    expect(imported.filter((name) => withdrawn.test(name))).toEqual([]);
  });
});
