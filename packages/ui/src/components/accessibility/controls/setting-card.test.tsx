import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { SettingCard } from './setting-card';

const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'mid', label: 'Medium' },
  { value: 'on', label: 'On' },
] as const;

describe('SettingCard', () => {
  it('renders the title and the current value label', () => {
    render(<SettingCard title="Contrast" options={OPTIONS} value="mid" onChange={() => {}} />);
    expect(screen.getByText('Contrast')).not.toBeNull();
    expect(screen.getByText('Medium')).not.toBeNull();
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
});
