import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArrivalNotice } from './arrival-notice';

describe('ArrivalNotice', () => {
  it('tells the reader what the link asked for and could not be given', () => {
    render(<ArrivalNotice message="This audit has no finding ZZ-999." />);

    expect(screen.getByRole('status')).toHaveTextContent('This audit has no finding ZZ-999.');
  });

  it('goes away once the reader has read it', () => {
    render(<ArrivalNotice message="This audit has no finding ZZ-999." />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays out of the way when the link was honoured', () => {
    render(<ArrivalNotice message={null} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
