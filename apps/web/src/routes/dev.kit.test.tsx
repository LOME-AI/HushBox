import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@tanstack/react-router';
import { screen, within } from '@testing-library/react';
import { ROUTES } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { Route } from './dev.kit';
import type { KitSection } from '@/components/dev/kit/kit-sections';

const mockEnv = vi.hoisted(() => ({ isDev: true }));
vi.mock('@/lib/platform/env', () => ({ env: mockEnv }));

const mockSections = vi.hoisted((): { list: KitSection[] } => ({ list: [] }));
vi.mock('@/components/dev/kit/kit-sections', () => ({
  get KIT_SECTIONS(): KitSection[] {
    return mockSections.list;
  },
}));

const LIGHT_THEME_NOTE = /light island needs the light theme/;

function section(title: string, part: number): KitSection {
  return { title, part, render: () => <p>{`${title} sample`}</p> };
}

function storeAppTheme(mode: 'light' | 'dark'): void {
  vi.mocked(localStorage.getItem).mockImplementation((key) => (key === 'themeMode' ? mode : null));
}

describe('/dev/kit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.isDev = true;
    mockSections.list = [section('Buttons', 2)];
    storeAppTheme('light');
  });

  describe('access', () => {
    it('allows the route in development', () => {
      const beforeLoad = Route.options.beforeLoad as (() => void) | undefined;
      expect(beforeLoad).toBeDefined();

      expect(() => {
        beforeLoad!();
      }).not.toThrow();
    });

    it('redirects to login outside development', () => {
      mockEnv.isDev = false;
      const beforeLoad = Route.options.beforeLoad as (() => void) | undefined;
      expect(beforeLoad).toBeDefined();

      let thrown: unknown;
      try {
        beforeLoad!();
      } catch (error: unknown) {
        thrown = error;
      }

      expect(isRedirect(thrown) ? thrown.options.to : thrown).toBe(ROUTES.LOGIN);
    });
  });

  it('renders a region per section, named by its title', () => {
    mockSections.list = [section('Buttons', 2), section('Fields', 3)];
    renderRoute(Route);

    expect(screen.getByRole('region', { name: 'Buttons' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fields' })).toBeInTheDocument();
  });

  it('names the catalog part each section is compared against', () => {
    renderRoute(Route);

    const region = screen.getByRole('region', { name: 'Buttons' });
    expect(within(region).getByText('catalog part 2')).toBeInTheDocument();
  });

  it('renders each section once in a light island', () => {
    renderRoute(Route);

    const region = screen.getByRole('region', { name: 'Buttons' });
    const light = within(region).getByRole('figure', { name: 'light' });
    expect(within(light).getByText('Buttons sample')).toBeInTheDocument();
  });

  it('renders each section once in a dark island', () => {
    renderRoute(Route);

    const region = screen.getByRole('region', { name: 'Buttons' });
    const dark = within(region).getByRole('figure', { name: 'dark' });
    expect(within(dark).getByText('Buttons sample')).toBeInTheDocument();
  });

  it('scopes the dark island to the dark theme tokens', () => {
    renderRoute(Route);

    expect(screen.getByRole('figure', { name: 'dark' })).toHaveClass('dark');
  });

  it('keeps the light island out of the dark theme scope', () => {
    renderRoute(Route);

    expect(screen.getByRole('figure', { name: 'light' })).not.toHaveClass('dark');
  });

  it('tells the reader the light island needs the light theme while the app is dark', () => {
    storeAppTheme('dark');
    renderRoute(Route);

    expect(screen.getByText(LIGHT_THEME_NOTE)).toBeInTheDocument();
  });

  it('shows no light theme note while the app is light', () => {
    renderRoute(Route);

    expect(screen.queryByText(LIGHT_THEME_NOTE)).not.toBeInTheDocument();
  });

  it('explains how to add a section when there are none', () => {
    mockSections.list = [];
    renderRoute(Route);

    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByText(/adds a section/)).toBeInTheDocument();
  });
});
