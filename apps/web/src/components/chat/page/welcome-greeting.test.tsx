import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WelcomeGreeting } from './welcome-greeting';

const reducedMotionRef = { current: true };

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return { ...actual, useReducedMotion: (): boolean => reducedMotionRef.current };
});

const GREETING = { title: 'Good morning', subtitle: 'Early starts lead somewhere' };

function subtitleIn(): HTMLElement {
  return screen.getByText(GREETING.subtitle);
}

describe('WelcomeGreeting', () => {
  beforeEach(() => {
    reducedMotionRef.current = true;
  });

  it('names the page with the greeting as its level-one heading', () => {
    render(<WelcomeGreeting greeting={GREETING} showSubtitle onTypingComplete={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(GREETING.title);
  });

  describe('while the greeting types out', () => {
    // The stylesheet is not loaded under test, so the class that hides the typing
    // animation's layout copy is given its rule here, as the app's stylesheet does.
    let hiddenRule: HTMLStyleElement;

    beforeEach(() => {
      reducedMotionRef.current = false;
      hiddenRule = document.createElement('style');
      hiddenRule.textContent = '.invisible { visibility: hidden; }';
      document.head.append(hiddenRule);
    });

    afterEach(() => {
      hiddenRule.remove();
    });

    it('names the heading with the whole greeting from the first render', () => {
      render(
        <WelcomeGreeting greeting={GREETING} showSubtitle={false} onTypingComplete={vi.fn()} />
      );

      expect(screen.getByRole('heading', { level: 1, name: GREETING.title })).toBeInTheDocument();
    });

    it('keeps the typing animation hidden from assistive technology', () => {
      render(
        <WelcomeGreeting greeting={GREETING} showSubtitle={false} onTypingComplete={vi.fn()} />
      );

      expect(screen.getByTestId('typing-animation').closest('[aria-hidden="true"]')).not.toBeNull();
    });
  });

  it('sets the greeting in the chat greeting role', () => {
    render(<WelcomeGreeting greeting={GREETING} showSubtitle onTypingComplete={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass(
      'font-serif',
      'text-chat-greeting'
    );
  });

  it('types the greeting out', () => {
    reducedMotionRef.current = false;
    render(<WelcomeGreeting greeting={GREETING} showSubtitle={false} onTypingComplete={vi.fn()} />);

    expect(screen.getByTestId('typed-text')).toHaveTextContent('');
  });

  it('marks the greeting as a reading surface', () => {
    const { container } = render(
      <WelcomeGreeting greeting={GREETING} showSubtitle onTypingComplete={vi.fn()} />
    );

    expect(container.firstElementChild).toHaveAttribute('data-reading', '');
  });

  it('reports when the greeting has finished typing', () => {
    const onTypingComplete = vi.fn();
    render(
      <WelcomeGreeting
        greeting={GREETING}
        showSubtitle={false}
        onTypingComplete={onTypingComplete}
      />
    );

    expect(onTypingComplete).toHaveBeenCalled();
  });

  it('holds the heading line while the greeting is still loading', () => {
    render(<WelcomeGreeting greeting={null} showSubtitle={false} onTypingComplete={vi.fn()} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.querySelector('.invisible')).not.toBeNull();
  });

  it('sets the sub-greeting muted in the lead size', () => {
    render(<WelcomeGreeting greeting={GREETING} showSubtitle onTypingComplete={vi.fn()} />);

    expect(subtitleIn()).toHaveClass('text-muted-foreground', 'mt-4', 'text-lg');
  });

  it('fades the sub-greeting up once asked to show it', () => {
    reducedMotionRef.current = false;
    render(<WelcomeGreeting greeting={GREETING} showSubtitle onTypingComplete={vi.fn()} />);

    expect(subtitleIn()).toHaveAttribute('data-animated', 'true');
  });

  it('keeps the sub-greeting hidden until asked to show it', () => {
    reducedMotionRef.current = false;
    render(<WelcomeGreeting greeting={GREETING} showSubtitle={false} onTypingComplete={vi.fn()} />);

    expect(subtitleIn().style.opacity).toBe('0');
  });

  it('shows the sub-greeting without motion when motion is reduced', () => {
    render(<WelcomeGreeting greeting={GREETING} showSubtitle onTypingComplete={vi.fn()} />);

    const subtitle = subtitleIn();
    expect(subtitle).toHaveAttribute('data-animated', 'false');
    expect(subtitle).not.toHaveClass('opacity-0');
    expect(subtitle.style.transform).toBe('');
  });

  it('keeps the sub-greeting hidden without motion until asked to show it', () => {
    render(<WelcomeGreeting greeting={GREETING} showSubtitle={false} onTypingComplete={vi.fn()} />);

    expect(subtitleIn()).toHaveClass('opacity-0');
  });

  it('keeps the sub-greeting line while the greeting is still loading', () => {
    const { container } = render(
      <WelcomeGreeting greeting={null} showSubtitle={false} onTypingComplete={vi.fn()} />
    );

    expect(container.querySelector('p')?.textContent).toBe(' ');
  });
});
