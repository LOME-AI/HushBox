import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { TEST_IDS } from '@hushbox/shared';

import { SettingCard } from './setting-card';

const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'mid', label: 'Medium' },
  { value: 'on', label: 'On' },
] as const;

type OptionValue = (typeof OPTIONS)[number]['value'];

/** The card as its sections mount it: the value it renders is the value it wrote. */
function LiveSettingCard(): React.JSX.Element {
  const [value, setValue] = useState<OptionValue>('off');
  return <SettingCard title="Contrast" options={OPTIONS} value={value} onChange={setValue} />;
}

describe('SettingCard', () => {
  it('renders the title and the current value label', () => {
    render(<SettingCard title="Contrast" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByText('Contrast')).not.toBeNull();
    expect(screen.getByText('Medium')).not.toBeNull();
  });

  it('hides the browser outline only while it has keyboard focus', () => {
    render(<SettingCard title="Contrast" options={OPTIONS} value="mid" onChange={() => {}} />);
    const card = screen.getByRole('button', { name: /Contrast/ });
    expect(
      [...card.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
    ).toEqual(['focus-visible:outline-hidden']);
  });

  it('cycles forward on click', () => {
    const onChange = vi.fn();
    render(<SettingCard title="Contrast" options={OPTIONS} value="off" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('mid');
  });

  it('wraps around from the last value back to the first', () => {
    const onChange = vi.fn();
    render(<SettingCard title="Contrast" options={OPTIONS} value="on" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('uses ArrowLeft to cycle backward', () => {
    const onChange = vi.fn();
    render(<SettingCard title="Contrast" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('uses ArrowRight / ArrowUp / Space / Enter to cycle forward', () => {
    for (const key of ['ArrowRight', 'ArrowUp', ' ', 'Enter']) {
      const onChange = vi.fn();
      render(<SettingCard title="X" options={OPTIONS} value="off" onChange={onChange} />);
      fireEvent.keyDown(screen.getByRole('button'), { key });
      expect(onChange).toHaveBeenCalledWith('mid');
      cleanup();
    }
  });

  it('jumps to first option with Home', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="on" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('jumps to last option with End', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="off" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('on');
  });

  it('exposes aria-label including title and current value label', () => {
    render(<SettingCard title="Contrast" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Contrast: Medium');
  });

  it('sets data-state="off" when the current value is the first option', () => {
    render(<SettingCard title="X" options={OPTIONS} value="off" onChange={() => {}} />);
    expect(screen.getByRole('button').dataset['state']).toBe('off');
  });

  it('sets data-state="on" when the current value is past the first option', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByRole('button').dataset['state']).toBe('on');
  });

  it('renders one dot per option', () => {
    render(<SettingCard title="X" options={OPTIONS} value="off" onChange={() => {}} />);
    const dots = screen
      .getByRole('button')
      .querySelectorAll('[data-slot="setting-card-dots"] > span');
    expect(dots).toHaveLength(OPTIONS.length);
  });

  it('marks exactly one dot as active matching the current value', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const dots = screen
      .getByRole('button')
      .querySelectorAll('[data-slot="setting-card-dots"] > span');
    const activeStates = [...dots].map((d) => (d as HTMLElement).dataset['active']);
    expect(activeStates).toEqual(['false', 'true', 'false']);
  });

  function forcedBackgrounds(value: OptionValue): string[][] {
    render(<SettingCard title="X" options={OPTIONS} value={value} onChange={() => {}} />);
    const dots = screen
      .getByRole('button')
      .querySelectorAll('[data-slot="setting-card-dots"] > span');
    return [...dots].map((dot) =>
      [...dot.classList].filter((token) => token.startsWith('forced-colors:bg-'))
    );
  }

  it.each(OPTIONS.map((option) => option.value))(
    'draws each dot other than the current one in CanvasText under forced colors at %s',
    (value) => {
      const currentIndex = OPTIONS.findIndex((option) => option.value === value);
      const others = forcedBackgrounds(value).filter((_, index) => index !== currentIndex);
      expect(others).toEqual([
        ['forced-colors:bg-[CanvasText]'],
        ['forced-colors:bg-[CanvasText]'],
      ]);
    }
  );

  it.each(OPTIONS.map((option) => option.value))(
    'draws the current dot in Highlight under forced colors at %s',
    (value) => {
      const currentIndex = OPTIONS.findIndex((option) => option.value === value);
      expect(forcedBackgrounds(value)[currentIndex]).toEqual(['forced-colors:bg-[Highlight]']);
    }
  );

  it('treats an unknown current value as index 0', () => {
    render(
      <SettingCard
        title="X"
        options={OPTIONS}
        value={'wat' as 'off' | 'mid' | 'on'}
        onChange={() => {}}
      />
    );
    expect(screen.getByText('Off')).not.toBeNull();
  });

  it('sets data-intensity proportional to current index', () => {
    render(<SettingCard title="X" options={OPTIONS} value="on" onChange={() => {}} />);
    expect(screen.getByRole('button').dataset['intensity']).toBe('1.00');
  });

  it('emits no onChange when ignored keys are pressed', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders a previous-arrow and next-arrow alongside the dots', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const button = screen.getByRole('button');
    expect(button.querySelector('[data-slot="setting-card-prev"]')).not.toBeNull();
    expect(button.querySelector('[data-slot="setting-card-next"]')).not.toBeNull();
  });

  it('marks both arrows as decorative (aria-hidden)', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const previous = screen.getByTestId(TEST_IDS.settingCardPrev);
    const next = screen.getByTestId(TEST_IDS.settingCardNext);
    expect(previous.getAttribute('aria-hidden')).toBe('true');
    expect(next.getAttribute('aria-hidden')).toBe('true');
  });

  it('clicking the previous arrow cycles backward', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.settingCardPrev));
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('clicking the next arrow cycles forward', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.settingCardNext));
    expect(onChange).toHaveBeenCalledWith('on');
  });

  it('clicking the previous arrow does not also trigger the card click handler', () => {
    const onChange = vi.fn();
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={onChange} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.settingCardPrev));
    // Forward cycle would call with 'on'; backward with 'off'. We must NOT see both.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('off');
  });

  const ARROW_TEST_IDS = [TEST_IDS.settingCardPrev, TEST_IDS.settingCardNext] as const;

  function arrowClasses(testId: string): string[] {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    return screen.getByTestId(testId).className.split(/\s+/);
  }

  it.each(ARROW_TEST_IDS)(
    'extends the %s hit area to a centred 2rem circle drawn outside the layout',
    (testId) => {
      expect(arrowClasses(testId)).toEqual(
        expect.arrayContaining([
          'relative',
          'before:absolute',
          'before:top-1/2',
          'before:left-1/2',
          'before:-translate-1/2',
          'before:size-8',
          'before:rounded-full',
        ])
      );
    }
  );

  it.each(ARROW_TEST_IDS)('grows the %s hit area to 2.75rem on a coarse pointer', (testId) => {
    expect(arrowClasses(testId)).toContain('pointer-coarse:before:size-11');
  });

  it.each(ARROW_TEST_IDS)('washes the %s hit area in the current colour on hover', (testId) => {
    expect(arrowClasses(testId)).toContain('hover:before:bg-current/12');
  });

  it.each(ARROW_TEST_IDS)('keeps the %s box at its resting 2px padding', (testId) => {
    expect(arrowClasses(testId)).toContain('p-0.5');
  });

  it.each(ARROW_TEST_IDS)('paints the %s chevron above its hover wash', (testId) => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const chevron = screen.getByTestId(testId).querySelector('svg');
    expect(chevron?.getAttribute('class')?.split(/\s+/)).toEqual(
      expect.arrayContaining(['relative', 'h-6', 'w-6'])
    );
  });

  it('renders dots inside a centered controls row alongside the arrows', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    const dots = screen
      .getByRole('button')
      .querySelector<HTMLElement>('[data-slot="setting-card-dots"]');
    expect(dots).not.toBeNull();
    expect(dots?.parentElement?.className).toContain('justify-center');
  });

  it('uses cursor-pointer so the card shows the clickable cursor on hover', () => {
    render(<SettingCard title="X" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByRole('button').className).toContain('cursor-pointer');
  });

  it('tints a below-neutral value with the info color', () => {
    render(
      <SettingCard title="X" options={OPTIONS} value="off" neutralIndex={2} onChange={() => {}} />
    );
    const button = screen.getByRole('button');
    expect(button.dataset['state']).toBe('on');
    expect(button.style.getPropertyValue('--a11y-card-bg')).toContain('--color-info');
  });

  it('tints an above-neutral value with the brand-red color', () => {
    render(
      <SettingCard title="X" options={OPTIONS} value="on" neutralIndex={0} onChange={() => {}} />
    );
    const button = screen.getByRole('button');
    expect(button.style.getPropertyValue('--a11y-card-bg')).toContain('--color-brand-red');
  });

  it('leaves the live region empty on mount so opening the widget announces nothing', () => {
    render(<LiveSettingCard />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('announces the new value label once the card cycles', () => {
    render(<LiveSettingCard />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('status')).toHaveTextContent('Medium');
  });

  it('keeps the live region outside the button so the accessible name is unchanged', () => {
    render(<LiveSettingCard />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).not.toContainElement(screen.getByRole('status'));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Contrast: Medium');
  });

  it('renders safely with no options and never emits onChange', () => {
    const onChange = vi.fn();
    render(<SettingCard<string> title="Empty" options={[]} value="x" onChange={onChange} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Home' });
    fireEvent.keyDown(button, { key: 'End' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
