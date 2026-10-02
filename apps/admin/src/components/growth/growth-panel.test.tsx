import * as React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PanelFrame } from '@hushbox/ui';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { ApiError } from '@/lib/api-client';
import { GrowthPanel, PANEL_GRID, panelDataOr, readOutcome } from './growth-panel.js';
import { panelScopeNote } from './panel-scope.js';
import type { PanelSpan } from './growth-panel.js';
import type { PanelScope } from './panel-scope.js';
import type { UseQueryResult } from '@tanstack/react-query';

interface Payload {
  readonly panels: {
    readonly thing: { ok: true; data: { n: number } } | { ok: false; error: string };
  };
}

function query(over: Partial<UseQueryResult<Payload>>): UseQueryResult<Payload> {
  return {
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
    ...over,
  } as UseQueryResult<Payload>;
}

const loaded = query({
  data: { panels: { thing: { ok: true, data: { n: 7 } } } },
});

/** A panel both of the page's controls reach, so it states no scope of its own. */
const GOVERNED: PanelScope = { campaigns: { kind: 'narrowed' }, window: { kind: 'selected-week' } };

/** A panel neither control reaches. */
const UNGOVERNED: PanelScope = {
  campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
  window: { kind: 'recent-days', days: 90 },
};

/**
 * The room the frame itself holds for a shape, so a panel's own room can be
 * held to it without this file spelling the frame's sizes a second time.
 */
function frameRoom(reserves: React.ComponentProps<typeof PanelFrame>['reserves']): string {
  const { container } = render(<PanelFrame title="Room" reserves={reserves} />);
  const body = container.querySelector('[data-slot="panel-frame-body"]');
  if (body === null) throw new Error('no body in the frame');
  return body.className;
}

/**
 * The classes the frame gives every panel root, so a caller's own class can be
 * shown to arrive beside them rather than instead of them without this file
 * spelling the frame's styling a second time.
 */
function frameClasses(): readonly string[] {
  const { container } = render(<PanelFrame title="Classes" />);
  const root = container.querySelector('[data-slot="panel-frame"]');
  if (root === null) throw new Error('no panel root in the frame');
  return [...root.classList];
}

/** One rendered panel's root, which is the element its classes land on. */
function panelRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-slot="panel-frame"]');
  if (!(root instanceof HTMLElement)) throw new Error('no panel root');
  return root;
}

/** The room one rendered panel holds, as the class its body carries. */
function panelRoom(container: HTMLElement): string {
  const body = container.querySelector('[data-slot="panel-frame-body"]');
  if (body === null) throw new Error('no body in the panel');
  return body.className;
}

describe('GrowthPanel', () => {
  it('holds the room the frame gives its shape, before its read answers', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        scope={GOVERNED}
        title="Thing"
        reserves="medium"
        query={query({ isPending: true })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(panelRoom(container)).toBe(frameRoom('medium'));
  });

  it('keeps that room once the read has answered, so the frame cannot shrink either', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        scope={GOVERNED}
        title="Thing"
        reserves="short"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={(data) => <p>count {data.n}</p>}
      />
    );
    expect(panelRoom(container)).toBe(frameRoom('short'));
  });

  it('holds the room of a panel that failed on its own, under the same mechanism', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        scope={GOVERNED}
        title="Thing"
        reserves="tall"
        query={query({ data: { panels: { thing: { ok: false, error: 'UNAVAILABLE' } } } })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(panelRoom(container)).toBe(frameRoom('tall'));
  });

  it('sets no height of its own, so one mechanism owns how much room a panel holds', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        scope={GOVERNED}
        title="Thing"
        reserves="medium"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={(data) => <p>count {data.n}</p>}
      />
    );
    const panel = container.querySelector('[data-slot="panel-frame"]');
    if (!(panel instanceof HTMLElement)) throw new Error('no panel section');
    expect(panel.style.minHeight).toBe('');
  });

  it('keeps its own classes beside the width its section gives it', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={(data) => <p>count {data.n}</p>}
      />
    );
    expect([...panelRoot(container).classList]).toEqual(
      expect.arrayContaining([...frameClasses(), 'lg:col-span-7'])
    );
  });

  it('keeps its width while its read is in flight', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ isPending: true })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(panelRoot(container)).toHaveClass('lg:col-span-7');
  });

  it('keeps its width once its read has failed', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ data: { panels: { thing: { ok: false, error: 'UNAVAILABLE' } } } })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(panelRoot(container)).toHaveClass('lg:col-span-7');
  });

  it('titles itself one level below the section heading it sits under', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={(data) => <p>count {data.n}</p>}
      />
    );
    expect(screen.getByRole('heading', { name: 'Thing', level: 3 })).toBeInTheDocument();
  });

  it('renders the panel content once the read answers', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={(data) => <p>count {data.n}</p>}
      />
    );
    expect(screen.getByText('count 7')).toBeInTheDocument();
  });

  it('shows a skeleton while the read is in flight', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ isPending: true })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(container.querySelector('[data-slot="panel-frame-skeleton"]')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('states the panel error code when the panel degraded on its own', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ data: { panels: { thing: { ok: false, error: 'UNAVAILABLE' } } } })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
  });

  it('never renders the panel content behind a degraded panel', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ data: { panels: { thing: { ok: false, error: 'UNAVAILABLE' } } } })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('states the failure code when the whole read was refused', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ isError: true, error: new ApiError('FORBIDDEN_ROLE', 403) })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByText('FORBIDDEN_ROLE')).toBeInTheDocument();
  });

  it('falls back to a generic code when the failure carried none', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ isError: true, error: new TypeError('network down') })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByText('INTERNAL')).toBeInTheDocument();
  });

  it('keeps a sibling panel rendering when one of them fails', () => {
    render(
      <>
        <GrowthPanel
          span={7}
          reserves="medium"
          scope={GOVERNED}
          title="Broken"
          query={query({ data: { panels: { thing: { ok: false, error: 'UNAVAILABLE' } } } })}
          panelOf={(payload) => payload.panels.thing}
          render={() => <p>broken content</p>}
        />
        <GrowthPanel
          span={7}
          reserves="medium"
          scope={GOVERNED}
          title="Working"
          query={loaded}
          panelOf={(payload) => payload.panels.thing}
          render={(data) => <p>working {data.n}</p>}
        />
      </>
    );
    expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('working 7')).toBeInTheDocument();
  });
});

describe('GrowthPanel frame anchor', () => {
  it('states a pending outcome on the frame while the read is in flight', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ isPending: true })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminGrowthPanel('pending'))).toBeInTheDocument();
  });

  it('states a failed outcome on the frame when the panel degraded on its own', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ data: { panels: { thing: { ok: false, error: 'UNAVAILABLE' } } } })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminGrowthPanel('failed'))).toBeInTheDocument();
  });

  it('states a failed outcome on the frame when the whole read was refused', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ isError: true, error: new ApiError('FORBIDDEN_ROLE', 403) })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminGrowthPanel('failed'))).toBeInTheDocument();
  });

  it('states an answered outcome on the frame once every read it draws on answered', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={(data) => <p>count {data.n}</p>}
      />
    );
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminGrowthPanel('answered'))).toBeInTheDocument();
  });

  it('states a pending outcome on the frame while a read besides its own is in flight', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        alsoReads={[readOutcome(query({ isPending: true }), (payload) => payload.panels.thing)]}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminGrowthPanel('pending'))).toBeInTheDocument();
  });

  it('states a failed outcome on the frame when a read besides its own failed', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        alsoReads={[
          readOutcome(
            query({ isError: true, error: new ApiError('UNAVAILABLE', 503) }),
            (payload) => payload.panels.thing
          ),
        ]}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminGrowthPanel('failed'))).toBeInTheDocument();
  });
});

describe('GrowthPanel drawing on a read besides its own', () => {
  const thing = (payload: Payload): Payload['panels']['thing'] => payload.panels.thing;

  it('shows a skeleton while that other read is in flight', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={thing}
        alsoReads={[readOutcome(query({ isPending: true }), thing)]}
        render={() => <p>content</p>}
      />
    );
    expect(container.querySelector('[data-slot="panel-frame-skeleton"]')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('states the code that other read was refused with', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={thing}
        alsoReads={[
          readOutcome(query({ isError: true, error: new ApiError('UNAVAILABLE', 503) }), thing),
        ]}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('states the code that other read degraded with', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={thing}
        alsoReads={[
          readOutcome(
            query({ data: { panels: { thing: { ok: false, error: 'INTERNAL' } } } }),
            thing
          ),
        ]}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByText('INTERNAL')).toBeInTheDocument();
  });

  it('renders the content once every read it draws on has answered', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={thing}
        alsoReads={[readOutcome(loaded, thing)]}
        render={(data) => <p>count {data.n}</p>}
      />
    );
    expect(screen.getByText('count 7')).toBeInTheDocument();
  });

  it("states its own failure code ahead of another read's", () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={query({ isError: true, error: new ApiError('FORBIDDEN_ROLE', 403) })}
        panelOf={thing}
        alsoReads={[
          readOutcome(query({ isError: true, error: new ApiError('UNAVAILABLE', 503) }), thing),
        ]}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByText('FORBIDDEN_ROLE')).toBeInTheDocument();
    expect(screen.queryByText('UNAVAILABLE')).not.toBeInTheDocument();
  });
});

describe('panelDataOr', () => {
  const FALLBACK = { n: 0 };

  it('returns the panel payload once the read answered', () => {
    expect(panelDataOr(loaded, (payload) => payload.panels.thing, FALLBACK)).toEqual({ n: 7 });
  });

  it('returns the fallback while the read is still in flight', () => {
    expect(
      panelDataOr(query({ isPending: true }), (payload) => payload.panels.thing, FALLBACK)
    ).toBe(FALLBACK);
  });

  it('returns the fallback when the panel degraded on its own', () => {
    const degraded = query({ data: { panels: { thing: { ok: false, error: 'UNAVAILABLE' } } } });
    expect(panelDataOr(degraded, (payload) => payload.panels.thing, FALLBACK)).toBe(FALLBACK);
  });
});

describe('GrowthPanel scope', () => {
  it('states what the panel covers when a control above it does not reach its read', () => {
    render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={UNGOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(screen.getByText(panelScopeNote(UNGOVERNED) ?? '')).toBeInTheDocument();
  });

  it('states no scope on a panel both controls reach', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(container.querySelector('[data-slot="panel-scope-note"]')).toBeNull();
  });

  it('states no scope beside a panel that never loaded', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={UNGOVERNED}
        title="Thing"
        query={query({ data: { panels: { thing: { ok: false, error: 'UNAVAILABLE' } } } })}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(container.querySelector('[data-slot="panel-scope-note"]')).toBeNull();
  });
});

describe('GrowthPanel scope chips', () => {
  /** The header row of the single panel a test rendered. */
  function headerOf(container: HTMLElement): HTMLElement {
    const header = container.querySelector<HTMLElement>('[data-slot="panel-frame-header"]');
    if (header === null) throw new Error('no panel header');
    return header;
  }

  function renderUngoverned(actions?: React.ReactNode): { container: HTMLElement } {
    return render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={UNGOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
        actions={actions}
      />
    );
  }

  it('shows one chip in the header for each control that does not reach the panel', () => {
    const { container } = renderUngoverned();
    expect(
      [...headerOf(container).querySelectorAll('[data-slot="panel-scope-chip"]')].map(
        (chip) => chip.textContent
      )
    ).toStrictEqual(['Every campaign', 'Last 90 days']);
  });

  it('draws no chip on a panel both controls reach', () => {
    const { container } = render(
      <GrowthPanel
        span={7}
        reserves="medium"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={() => <p>content</p>}
      />
    );
    expect(container.querySelector('[data-slot="panel-scope-chip"]')).toBeNull();
  });

  it('makes each chip focusable, so the clause behind it is reachable without a pointer', () => {
    renderUngoverned();
    const chip = screen.getByRole('button', { name: 'Every campaign' });
    act(() => {
      chip.focus();
    });
    expect(chip).toHaveFocus();
  });

  it("hides each chip's browser outline only while it has keyboard focus", () => {
    const { container } = renderUngoverned();
    const suppressions = [
      ...headerOf(container).querySelectorAll<HTMLElement>('[data-slot="panel-scope-chip"]'),
    ].map((chip) =>
      [...chip.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
    );
    expect(suppressions).toEqual([
      ['focus-visible:outline-hidden'],
      ['focus-visible:outline-hidden'],
    ]);
  });

  it('keeps the whole clause in the document with no tooltip opened', () => {
    renderUngoverned();
    expect(screen.getByText(panelScopeNote(UNGOVERNED) ?? '')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('draws the panel actions in the header rather than in a row of its body', () => {
    const { container } = renderUngoverned(<button type="button">Export</button>);
    expect(within(headerOf(container)).getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });
});

describe('the grid a section lays its panels out in', () => {
  /** How many columns the grid declares at the breakpoint the spans apply at. */
  function declaredColumns(): number {
    const written = /lg:grid-cols-(\d+)/.exec(PANEL_GRID);
    if (written === null) throw new Error('the grid declares no column count');
    return Number(written[1]);
  }

  /**
   * Every span a caller may write. The compiler keeps it exhaustive: a span the
   * panel gains and this list does not stops this file type-checking.
   */
  const EVERY_SPAN = Object.values({
    4: 4,
    5: 5,
    6: 6,
    7: 7,
    8: 8,
    full: 'full',
  } as const satisfies Record<PanelSpan, PanelSpan>);

  /** The spans written for a pairing, which are the ones counted in columns. */
  const PAIRED_SPANS = EVERY_SPAN.filter(
    (span): span is Exclude<PanelSpan, 'full'> => span !== 'full'
  );

  /** The width classes one panel is drawn with, for the span it was given. */
  function spanClasses(span: PanelSpan): readonly string[] {
    const { container } = render(
      <GrowthPanel
        span={span}
        reserves="short"
        scope={GOVERNED}
        title="Thing"
        query={loaded}
        panelOf={(payload) => payload.panels.thing}
        render={(data) => <p>count {data.n}</p>}
      />
    );
    return [...panelRoot(container).classList].filter((name) => name.includes('col-span'));
  }

  it('takes as many columns as its span names', () => {
    for (const span of PAIRED_SPANS) {
      expect(spanClasses(span)).toEqual([`lg:col-span-${String(span)}`]);
    }
  });

  it('gives a panel that pairs with nothing the whole row', () => {
    expect(spanClasses('full')).toEqual(['lg:col-span-full']);
  });

  it('offers no span wider than the grid it is written for', () => {
    const columns = declaredColumns();
    expect(columns).toBeGreaterThan(1);
    for (const span of PAIRED_SPANS) {
      expect(span).toBeLessThanOrEqual(columns);
    }
  });

  it('lets a panel shrink below its own content, whatever it spans', () => {
    expect(PANEL_GRID).toContain('*:min-w-0');
  });
});
