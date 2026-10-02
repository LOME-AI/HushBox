import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerdictPill } from './verdict-pill';
import { VERDICTS } from '../engine';

describe('VerdictPill', () => {
  it.each(VERDICTS)('spells out the %s level in text, not colour alone', (level) => {
    render(<VerdictPill level={level} />);

    expect(screen.getByText(level.toUpperCase())).toBeInTheDocument();
  });

  it('appends the audience label when one is supplied', () => {
    render(<VerdictPill level="warn">AI answer bots</VerdictPill>);

    expect(screen.getByText('WARN')).toBeInTheDocument();
    expect(screen.getByText('AI answer bots')).toBeInTheDocument();
  });

  it('renders only the level when no label is supplied', () => {
    const { container } = render(<VerdictPill level="fail" />);

    expect(container.textContent).toBe('✗FAIL');
  });
});
