import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { AuditSwitcher } from './audit-switcher';

describe('AuditSwitcher', () => {
  it('shows the audit the console is serving', () => {
    render(
      <AuditSwitcher
        name="2026-07-30"
        audits={['2026-07-30', '2026-06-01']}
        onSwitch={vi.fn()}
        bulkRunning={false}
      />
    );

    expect(screen.getByTestId(TEST_IDS.auditSwitcher)).toHaveValue('2026-07-30');
  });

  /**
   * Exactly the audits it was handed, in the order it was handed them: the
   * server has already ruled which directories are audits, so a second opinion
   * here could only disagree with it.
   */
  it('lists every audit found beside it', () => {
    render(
      <AuditSwitcher
        name="2026-07-30"
        audits={['2026-07-30', '2026-06-01']}
        onSwitch={vi.fn()}
        bulkRunning={false}
      />
    );

    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['2026-07-30', '2026-06-01']);
    expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual([
      '2026-07-30',
      '2026-06-01',
    ]);
  });

  it('is labelled for a reader who cannot see the layout', () => {
    render(
      <AuditSwitcher
        name="2026-07-30"
        audits={['2026-07-30']}
        onSwitch={vi.fn()}
        bulkRunning={false}
      />
    );

    expect(screen.getByTestId(TEST_IDS.auditSwitcher)).toHaveAccessibleName('Audit');
  });

  it('sends the audit the reader chose to its parent', () => {
    const onSwitch = vi.fn();
    render(
      <AuditSwitcher
        name="2026-07-30"
        audits={['2026-07-30', '2026-06-01']}
        onSwitch={onSwitch}
        bulkRunning={false}
      />
    );

    fireEvent.change(screen.getByTestId(TEST_IDS.auditSwitcher), {
      target: { value: '2026-06-01' },
    });

    expect(onSwitch).toHaveBeenCalledWith('2026-06-01');
  });

  /**
   * A native `<select>` fires `change` only on a committed change of value, so only a
   * control that re-fires on re-selection — a custom combobox — reaches this guard.
   */
  it('ignores the audit already on screen', () => {
    const onSwitch = vi.fn();
    render(
      <AuditSwitcher
        name="2026-07-30"
        audits={['2026-07-30', '2026-06-01']}
        onSwitch={onSwitch}
        bulkRunning={false}
      />
    );

    fireEvent.change(screen.getByTestId(TEST_IDS.auditSwitcher), {
      target: { value: '2026-07-30' },
    });

    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('holds the switch while a bulk ruling is running', () => {
    render(
      <AuditSwitcher
        name="2026-07-30"
        audits={['2026-07-30', '2026-06-01']}
        onSwitch={vi.fn()}
        bulkRunning
      />
    );

    const control = screen.getByTestId(TEST_IDS.auditSwitcher);
    expect(control).toBeDisabled();
    expect(control).toHaveAccessibleDescription(
      'Switching is held until the bulk ruling finishes.'
    );
  });

  it('offers the switch again once the bulk ruling finishes', () => {
    const { rerender } = render(
      <AuditSwitcher
        name="2026-07-30"
        audits={['2026-07-30', '2026-06-01']}
        onSwitch={vi.fn()}
        bulkRunning
      />
    );

    rerender(
      <AuditSwitcher
        name="2026-07-30"
        audits={['2026-07-30', '2026-06-01']}
        onSwitch={vi.fn()}
        bulkRunning={false}
      />
    );

    const control = screen.getByTestId(TEST_IDS.auditSwitcher);
    expect(control).toBeEnabled();
    expect(control).not.toHaveAccessibleDescription();
  });
});
