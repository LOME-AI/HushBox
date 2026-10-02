import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Heading, Text } from '@hushbox/ui/type';

describe('@hushbox/ui/type', () => {
  it('publishes Heading', () => {
    render(
      <Heading level={2} variant="title-2">
        How billing works
      </Heading>
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-title-2');
  });

  it('publishes Text', () => {
    render(<Text variant="caption">Caption</Text>);

    expect(screen.getByText('Caption')).toHaveClass('text-caption');
  });
});
