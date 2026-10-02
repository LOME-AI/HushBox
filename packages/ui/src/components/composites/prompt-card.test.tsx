import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PromptCard } from './prompt-card';

describe('PromptCard', () => {
  it('has data-slot attribute', () => {
    render(<PromptCard heading="Turn on notifications" data-testid="prompt" />);

    expect(screen.getByTestId('prompt')).toHaveAttribute('data-slot', 'prompt-card');
  });

  it('announces politely rather than taking focus', () => {
    render(<PromptCard heading="Turn on notifications" data-testid="prompt" />);

    expect(screen.getByTestId('prompt')).toHaveAttribute('role', 'status');
  });

  it('renders the heading', () => {
    render(<PromptCard heading="Where did you hear about HushBox?" />);

    expect(
      screen.getByRole('heading', { name: 'Where did you hear about HushBox?' })
    ).toBeInTheDocument();
  });

  it('renders the body', () => {
    render(<PromptCard heading="Turn on notifications" body="Optional." />);

    expect(screen.getByText('Optional.')).toBeInTheDocument();
  });

  it('omits the body when none is given', () => {
    const { container } = render(<PromptCard heading="Turn on notifications" />);

    expect(container.querySelector('[data-slot="prompt-card-body"]')).toBeNull();
  });

  it('renders the primary answer as a button', async () => {
    const onPrimary = vi.fn();
    render(<PromptCard heading="Turn on notifications" primary={{ label: 'Enable', onPrimary }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));

    expect(onPrimary).toHaveBeenCalledOnce();
  });

  it('renders the secondary answer as a button', async () => {
    const onSecondary = vi.fn();
    render(
      <PromptCard heading="Turn on notifications" secondary={{ label: 'Later', onSecondary }} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Later' }));

    expect(onSecondary).toHaveBeenCalledOnce();
  });

  it('disables the primary answer while it is being acted on', () => {
    render(
      <PromptCard
        heading="Turn on notifications"
        primary={{ label: 'Enable', onPrimary: vi.fn(), isBusy: true }}
      />
    );

    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
  });

  it('disables an answer there is nothing to do with yet', () => {
    render(
      <PromptCard
        heading="Where did you hear about HushBox?"
        primary={{ label: 'Done', onPrimary: undefined }}
      />
    );

    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  });

  it('disables a secondary answer there is nothing to do with yet', () => {
    render(
      <PromptCard
        heading="Turn on notifications"
        secondary={{ label: 'Later', onSecondary: undefined }}
      />
    );

    expect(screen.getByRole('button', { name: 'Later' })).toBeDisabled();
  });

  it('renders content between the body and the answers', () => {
    render(
      <PromptCard heading="Where did you hear about HushBox?">
        <span data-testid="chips" />
      </PromptCard>
    );

    expect(screen.getByTestId('chips')).toBeInTheDocument();
  });

  it('omits the answer row when the card offers neither answer', () => {
    const { container } = render(<PromptCard heading="Turn on notifications" />);

    expect(container.querySelector('[data-slot="prompt-card-answers"]')).toBeNull();
  });
});
