import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import {
  NOTICE_COPY,
  TEST_IDS,
  noticeText,
  notices,
  type Model,
  type RefusalCode,
} from '@hushbox/shared';
import { ModelListItem } from '@/components/chat/model-selector/model-list-item';
import type { ModelListItemProps } from '@/components/chat/model-selector/model-list-item';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <a href={to} className={className} data-testid="overlay-link" onClick={onClick}>
      {children}
    </a>
  ),
}));

function makeModel(): Model {
  return {
    id: 'm1',
    name: 'Test Model',
    description: 'desc',
    provider: 'prov',
    modality: 'text',
    contextLength: 8000,
    supportedParameters: [],
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  };
}

function baseProps(overrides: Partial<ModelListItemProps> = {}): ModelListItemProps {
  return {
    model: makeModel(),
    isFocused: false,
    isSelected: false,
    isDisabled: false,
    availability: { available: true },
    pickerMode: 'single',
    isExpanded: false,
    isMobile: false,
    isPulsing: false,
    cascadeIndex: 0,
    onActivate: vi.fn(),
    onHover: vi.fn(),
    onShowInfo: vi.fn(),
    onToggleExpand: vi.fn(),
    ...overrides,
  };
}

function renderItem(props: ModelListItemProps): void {
  render(
    <TouchDeviceOverrideContext value={false}>
      <ModelListItem {...props} />
    </TouchDeviceOverrideContext>
  );
}

describe('ModelListItem premium overlay', () => {
  it("offers the reason's action as a link and does not activate the row when it is clicked", () => {
    const onActivate = vi.fn();
    renderItem(
      baseProps({
        availability: { available: false, reason: 'premium_requires_credit' },
        onActivate,
      })
    );

    const link = screen.getByTestId('overlay-link');
    // The wording comes from the shared vocabulary, not from this component.
    expect(link).toHaveTextContent('Add credit');

    fireEvent.click(link);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('offers the sign-up action for a payer with no account', () => {
    renderItem(
      baseProps({ availability: { available: false, reason: 'premium_requires_account' } })
    );

    expect(screen.getByTestId('overlay-link')).toHaveTextContent('Sign up');
  });

  it('decorates nothing when the producer marked the row available', () => {
    // Whether a link guest may reach a premium model is the PRODUCER's verdict
    // (it knows the tier); the row renders what it is given and holds no rule
    // of its own about who is exempt.
    renderItem(baseProps({ availability: { available: true } }));
    expect(screen.queryByTestId('overlay-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.premiumOverlay)).not.toBeInTheDocument();
  });

  it('activates the row when the main button is clicked', () => {
    const onActivate = vi.fn();
    renderItem(baseProps({ onActivate }));
    fireEvent.click(screen.getByRole('button', { name: 'Use Test Model' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe('ModelListItem keyboard highlight', () => {
  it('leaves forced colors an outline to paint on the row the keyboard is on', () => {
    renderItem(baseProps({ isFocused: true }));
    expect(screen.getByRole('option')).toHaveClass('outline-hidden');
  });

  it('leaves no outline class on a row the keyboard is not on', () => {
    renderItem(baseProps({ isFocused: false }));
    expect(screen.getByRole('option')).not.toHaveClass('outline-hidden');
  });
});

describe('ModelListItem — typed reasons drive every disabled row', () => {
  /**
   * The picker renders the produced verdict. It never classifies a model, so
   * these fixtures pass an `Availability` exactly as `affordable.all` carries
   * it — a premium lock and a funding shortfall differ only in their reason.
   */
  function unavailable(reason: RefusalCode): Partial<ModelListItemProps> {
    return { availability: { available: false, reason } };
  }

  it.each([
    ['premium_requires_credit'],
    ['premium_requires_account'],
    ['insufficient_funds'],
    ['prompt_too_long'],
  ] as const)('renders %s as the shared copy, never a local sentence', (reason) => {
    render(<ModelListItem {...baseProps(unavailable(reason))} />);

    // The one home for money copy. A locally authored sentence would be a
    // second phrasing of a condition that already has exactly one.
    const expected = noticeText(reason);
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
  });

  it('keeps an unavailable row PRESENT, operable and explained', () => {
    const onActivate = vi.fn();
    render(
      <ModelListItem {...baseProps({ ...unavailable('premium_requires_credit'), onActivate })} />
    );

    const row = screen.getByRole('option');
    // Marked, never filtered: the row exists and is still reachable.
    expect(row).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Use Test Model/ });
    // Clicking the row is what unsticks the payer — it routes to the paywall —
    // so declaring it inoperable would deny assistive technology the one
    // affordance the row has.
    expect(button).not.toHaveAttribute('aria-disabled');
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
    // The reason reaches a screen reader through aria-describedby.
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.querySelector(`[id="${describedBy ?? ''}"]`)).toHaveTextContent(
      noticeText('premium_requires_credit')
    );
  });

  it('leaves an available row undecorated and selectable', () => {
    render(<ModelListItem {...baseProps({ availability: { available: true } })} />);

    const button = screen.getByRole('button', { name: /Use Test Model/ });
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('option')).not.toHaveAttribute('data-unavailable');
  });

  it('still reports activation on an unavailable row, so the container can route it', () => {
    // The row must not swallow the click: the container routes a premium lock
    // to the paywall and allows de-selecting a row that became unavailable.
    // Whether the click SELECTS is the container's call, pinned there.
    const onActivate = vi.fn();
    render(<ModelListItem {...baseProps({ ...unavailable('insufficient_funds'), onActivate })} />);

    fireEvent.click(screen.getByRole('button', { name: /Use Test Model/ }));

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('surfaces no tooltip when an unavailable row takes focus', () => {
    // The click routes the refusal to the signup or payment modal, and the
    // sr-only reason carries it to a screen reader. A hover-only overlay
    // repeating the same sentence is a third phrasing surface with no reader.
    render(<ModelListItem {...baseProps(unavailable('insufficient_funds'))} />);

    fireEvent.focus(screen.getByRole('button', { name: /Use Test Model/ }));

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

describe('ModelListItem — a greyed row dims once and stays clickable', () => {
  const GREYED_REASON = 'insufficient_funds';

  function greyed(): ModelListItemProps {
    return baseProps({ availability: { available: false, reason: GREYED_REASON } });
  }

  it('leaves the wash overlay as the only dim on a greyed row', () => {
    render(<ModelListItem {...greyed()} />);

    // Text stays at full contrast: the overlay is the whole treatment, so a
    // second dim on the row would grey the greying.
    expect(screen.getByRole('option').className).not.toMatch(/opacity-/);
    expect(screen.getByTestId(TEST_IDS.premiumOverlay).className).toContain(
      'bg-background/60 pointer-events-none'
    );
  });

  it('announces the at-cap row as disabled', () => {
    render(<ModelListItem {...baseProps({ isDisabled: true })} />);

    expect(screen.getByRole('option')).toHaveAttribute('aria-disabled', 'true');
  });

  it('announces nothing disabled on a selectable row', () => {
    render(<ModelListItem {...baseProps()} />);

    expect(screen.getByRole('option')).not.toHaveAttribute('aria-disabled');
  });

  it('reads as clickable on a greyed row', () => {
    render(<ModelListItem {...greyed()} />);

    const button = screen.getByRole('button', { name: /Use Test Model/ });
    // The click opens the signup or payment modal, so the row is an offer
    // rather than a refusal and its cursor and hover must say so.
    expect(button.className).toContain('cursor-pointer');
    expect(button.className).not.toContain('cursor-not-allowed');
    expect(button.className).toContain('hover:bg-muted');
  });

  it('marks the greyed row with a lock beside its name', () => {
    render(<ModelListItem {...greyed()} />);

    expect(screen.getByTestId(TEST_IDS.lockIcon)).toBeInTheDocument();
  });

  it('splits the action clause into a link and a plain remainder', () => {
    renderItem(greyed());

    // Both halves are read off the shared vocabulary. A restated literal keeps
    // passing after the copy moves, which is the one moment it has to fail.
    const segments = NOTICE_COPY[GREYED_REASON].action;
    expect(segments.some((segment) => segment.link !== undefined)).toBe(true);
    expect(segments.some((segment) => segment.link === undefined)).toBe(true);
    for (const segment of segments) {
      expect(screen.getByText(segment.text).className).toContain(
        segment.link === undefined ? 'text-muted-foreground' : 'text-primary'
      );
    }
  });
});

describe('ModelListItem — the row renders the notice the money module produces', () => {
  /**
   * The row hands the produced verdict back to the money module and renders the
   * answer. It holds no copy map and composes no sentence, so a refusal the
   * producer attributed to the selection is worded by the module rather than by
   * a rule kept here — the attribution is the producer's to read and the copy is
   * the producer's to choose.
   */
  const SELECTION_BLOCKED = {
    available: false,
    reason: 'insufficient_funds',
    causedBy: 'selection',
  } as const;

  it('shows the produced action clause as the row`s visible copy', () => {
    renderItem(baseProps({ availability: SELECTION_BLOCKED }));

    for (const segment of notices(SELECTION_BLOCKED).action) {
      expect(screen.getByText(segment.text)).toBeInTheDocument();
    }
  });

  it('gives a screen reader the produced sentence whole', () => {
    renderItem(baseProps({ availability: SELECTION_BLOCKED }));

    const describedBy = screen
      .getByRole('button', { name: /Use Test Model/ })
      .getAttribute('aria-describedby');
    expect(document.querySelector(`[id="${describedBy ?? ''}"]`)).toHaveTextContent(
      notices(SELECTION_BLOCKED).message
    );
  });

  it('leaves the cause out of what a sighted reader sees', () => {
    // The two channels are distinct: the cause names the condition and reaches
    // a screen reader only, so a row rendering the whole sentence visibly would
    // read as a statement about the row the user is looking at.
    renderItem(baseProps({ availability: SELECTION_BLOCKED }));

    // The row's button is the whole of what is drawn; the sentence's other
    // channel lives in a sibling the sr-only class hides.
    const visible = screen.getByRole('button', { name: /Use Test Model/ }).textContent;
    const notice = notices(SELECTION_BLOCKED);
    const actionText = notice.action.map((segment) => segment.text).join('');
    const cause = notice.message.slice(0, notice.message.length - actionText.length);

    expect(visible).toContain(actionText);
    expect(visible).not.toContain(cause.trim());
  });
});

/**
 * A viewport `width` CSS pixels wide whose primary pointer is `pointer`, as
 * `matchMedia` reports it: a max-width query matches at or below its bound,
 * and the coarse-pointer query matches only for a coarse pointer.
 */
function stubFormFactor(width: number, pointer: 'fine' | 'coarse'): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const maxWidth = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches =
      maxWidth === null
        ? query === '(pointer: coarse)' && pointer === 'coarse'
        : width <= Number(maxWidth[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  });
}

/** The row as the picker renders it, which passes the phone band down as `isMobile`. */
function renderRowAt(width: number, pointer: 'fine' | 'coarse'): void {
  stubFormFactor(width, pointer);
  render(<ModelListItem {...baseProps({ isMobile: width < 768 })} />);
}

describe('ModelListItem trailing control at each form factor', () => {
  it('offers the expand chevron rather than the info button on a phone', () => {
    renderRowAt(390, 'coarse');
    expect(screen.getByTestId(TEST_IDS.rowExpandChevron)).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.rowInfoIcon)).not.toBeInTheDocument();
  });

  it('offers the info button on a tablet, where a coarse pointer cannot hover for details', () => {
    renderRowAt(834, 'coarse');
    expect(screen.getByTestId(TEST_IDS.rowInfoIcon)).toBeInTheDocument();
  });

  it('offers no info button on a desktop with a fine pointer, which hovers for details', () => {
    renderRowAt(1440, 'fine');
    expect(screen.queryByTestId(TEST_IDS.rowInfoIcon)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.rowExpandChevron)).not.toBeInTheDocument();
  });
});
