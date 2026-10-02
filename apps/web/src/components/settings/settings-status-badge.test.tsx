import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Check } from '@hushbox/ui/icons';
import { Badge, type BadgeTone } from '@hushbox/ui/marks';
import { SettingsStatusBadge } from '@/components/settings/settings-status-badge';

/** The classes the foundation Badge draws for a tone, read from a rendered reference. */
function toneClasses(tone: BadgeTone): string {
  const { unmount } = render(<Badge tone={tone}>Reference</Badge>);
  const className = screen.getByText('Reference').className;
  unmount();
  return className;
}

describe('SettingsStatusBadge', () => {
  it.each([
    ['Enabled', 'success'],
    ['Active', 'success'],
    ['Verified', 'success'],
    ['Disabled', 'neutral'],
    ['Not set', 'neutral'],
    ['Loading...', 'neutral'],
    ['Not verified', 'warning'],
    ['Blocked', 'warning'],
    ['Allowed', 'success'],
    ['Not asked', 'neutral'],
    ['Not supported', 'neutral'],
    ['Not set up', 'warning'],
  ] as const)('shows %s in the %s tone', (status, tone) => {
    const expected = toneClasses(tone);
    render(<SettingsStatusBadge status={status} />);

    expect(screen.getByText(status).className).toBe(expected);
  });

  it('writes no tone attribute of its own into the page', () => {
    render(<SettingsStatusBadge status="Blocked" />);

    expect(screen.getByText('Blocked')).not.toHaveAttribute('data-tone');
  });

  it('draws the icon it is given', () => {
    render(<SettingsStatusBadge status="Verified" icon={Check} />);

    expect(screen.getByText('Verified').querySelector('svg')).not.toBeNull();
  });

  it('draws no icon when none is given', () => {
    render(<SettingsStatusBadge status="Verified" />);

    expect(screen.getByText('Verified').querySelector('svg')).toBeNull();
  });
});
