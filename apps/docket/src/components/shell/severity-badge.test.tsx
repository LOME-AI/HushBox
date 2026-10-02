import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityBadge } from './severity-badge';

describe('SeverityBadge', () => {
  it('names the severity in text, never by color alone', () => {
    render(<SeverityBadge severity="critical" />);

    expect(screen.getByText('critical')).toBeInTheDocument();
  });

  it('marks a critical finding as danger', () => {
    render(<SeverityBadge severity="critical" />);

    expect(screen.getByText('critical').className).toContain('text-error');
  });

  it('marks a high finding as danger', () => {
    render(<SeverityBadge severity="high" />);

    expect(screen.getByText('high').className).toContain('text-error');
  });

  it('keeps a low finding quiet', () => {
    render(<SeverityBadge severity="low" />);

    expect(screen.getByText('low').className).toContain('muted');
  });

  it('renders every severity the format allows', () => {
    render(
      <>
        <SeverityBadge severity="high" />
        <SeverityBadge severity="medium" />
      </>
    );

    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
  });
});
