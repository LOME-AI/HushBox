import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { StatTile } from './stat-tile';

const ICON = <svg data-testid="icon" />;

describe('StatTile', () => {
  it('renders the label and the value', () => {
    render(
      <StatTile icon={ICON} label="Total Spent" value="$12.50" isLoading={false} testId="tile" />
    );

    expect(screen.getByText('Total Spent')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_ID_BUILDERS.kpiValue('tile'))).toHaveTextContent('$12.50');
  });

  it('renders the icon', () => {
    render(<StatTile icon={ICON} label="Messages" value="20" isLoading={false} testId="tile" />);

    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('tags the tile with the caller-supplied test id', () => {
    render(<StatTile icon={ICON} label="Messages" value="20" isLoading={false} testId="tile" />);

    expect(screen.getByTestId('tile')).toBeInTheDocument();
  });

  it('renders two skeleton blocks while loading', () => {
    render(<StatTile icon={ICON} label="Messages" value="20" isLoading testId="tile" />);

    expect(screen.getAllByTestId(TEST_IDS.skeletonBlock)).toHaveLength(2);
  });

  it('renders neither the value nor the label while loading', () => {
    render(<StatTile icon={ICON} label="Messages" value="20" isLoading testId="tile" />);

    expect(screen.queryByTestId(TEST_ID_BUILDERS.kpiValue('tile'))).not.toBeInTheDocument();
    expect(screen.queryByText('Messages')).not.toBeInTheDocument();
  });

  it('has a data-slot attribute', () => {
    render(<StatTile icon={ICON} label="Messages" value="20" isLoading={false} testId="tile" />);

    expect(screen.getByTestId('tile')).toHaveAttribute('data-slot', 'stat-tile');
  });

  it('applies a custom className to the tile root', () => {
    render(
      <StatTile
        icon={ICON}
        label="Messages"
        value="20"
        isLoading={false}
        testId="tile"
        className="col-span-2"
      />
    );

    expect(screen.getByTestId('tile')).toHaveClass('col-span-2');
  });
});
