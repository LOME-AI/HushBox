import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NoticeStack } from './notice-stack';

describe('NoticeStack', () => {
  it('stacks its notices 0.5rem apart', () => {
    render(
      <NoticeStack>
        <p>First</p>
        <p>Second</p>
      </NoticeStack>
    );

    expect(screen.getByText('First').parentElement).toHaveClass('flex', 'flex-col', 'gap-2');
  });
});
