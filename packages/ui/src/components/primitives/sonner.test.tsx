import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { toast } from 'sonner';
import { Toaster } from './sonner';

function toaster(): Element | null {
  return document.querySelector('[data-sonner-toaster]');
}

function noop(): void {
  /* MediaQueryList listener registration the stub does not need to honour. */
}

/** Makes `prefers-color-scheme: dark` match, which is what Sonner's own `'system'` resolution reads. */
function stubOsPrefersDark(): void {
  vi.spyOn(globalThis, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-color-scheme: dark'),
        media: query,
        onchange: null,
        addEventListener: noop,
        removeEventListener: noop,
        addListener: noop,
        removeListener: noop,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  );
}

describe('Toaster', () => {
  afterEach(async () => {
    // The class removal is a state change for any toaster still mounted at this
    // point: Testing Library's own cleanup hook runs after this one. The act is
    // async because the MutationObserver behind the re-theme delivers on a
    // microtask, and the awaited resolve is what drains it inside the act.
    await act(async () => {
      document.documentElement.classList.remove('dark');
      await Promise.resolve();
    });
    vi.restoreAllMocks();
  });

  it('renders toaster container', () => {
    render(<Toaster />);
    // Sonner renders a section element for notifications
    expect(screen.getByRole('region')).toBeInTheDocument();
  });

  it('displays toast message', async () => {
    render(<Toaster />);
    toast('Test message');
    await waitFor(() => {
      expect(screen.getByText('Test message')).toBeInTheDocument();
    });
  });

  it('displays success toast', async () => {
    render(<Toaster />);
    toast.success('Success message');
    await waitFor(() => {
      expect(screen.getByText('Success message')).toBeInTheDocument();
    });
  });

  it('displays error toast', async () => {
    render(<Toaster />);
    toast.error('Error message');
    await waitFor(() => {
      expect(screen.getByText('Error message')).toBeInTheDocument();
    });
  });

  it('displays warning toast', async () => {
    render(<Toaster />);
    toast.warning('Warning message');
    await waitFor(() => {
      expect(screen.getByText('Warning message')).toBeInTheDocument();
    });
  });

  it('displays info toast', async () => {
    render(<Toaster />);
    toast.info('Info message');
    await waitFor(() => {
      expect(screen.getByText('Info message')).toBeInTheDocument();
    });
  });

  it('themes dark when the document root carries the dark class', async () => {
    document.documentElement.classList.add('dark');
    render(<Toaster />);
    act(() => {
      toast('Dark-rooted message');
    });

    await waitFor(() => {
      expect(toaster()).toHaveAttribute('data-sonner-theme', 'dark');
    });
  });

  it('themes light without the dark class even when the OS prefers dark', async () => {
    stubOsPrefersDark();
    render(<Toaster />);
    act(() => {
      toast('Light-rooted message');
    });

    await waitFor(() => {
      expect(toaster()).toHaveAttribute('data-sonner-theme', 'light');
    });
  });

  it('lets an explicit theme override the document root', async () => {
    document.documentElement.classList.add('dark');
    render(<Toaster theme="light" />);
    act(() => {
      toast('Overridden message');
    });

    await waitFor(() => {
      expect(toaster()).toHaveAttribute('data-sonner-theme', 'light');
    });
  });

  it('re-themes a mounted toaster when the document root class flips', async () => {
    render(<Toaster />);
    act(() => {
      toast('Live message');
    });
    await waitFor(() => {
      expect(toaster()).toHaveAttribute('data-sonner-theme', 'light');
    });

    await act(async () => {
      document.documentElement.classList.add('dark');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toaster()).toHaveAttribute('data-sonner-theme', 'dark');
    });
  });
});
