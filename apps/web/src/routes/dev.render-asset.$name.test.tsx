import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { RenderAssetPage } from './dev.render-asset.$name';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  redirect: (options: Record<string, unknown>) => options,
  useParams: vi.fn(),
}));

mockLogoImport();

vi.mock('@hushbox/ui', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

const { useParams } = await import('@tanstack/react-router');
const mockedUseParams = vi.mocked(useParams);

describe('RenderAssetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders app-icon component when name is "icon-only"', () => {
    mockedUseParams.mockReturnValue({ name: 'icon-only' });
    render(<RenderAssetPage />);
    expect(screen.getByTestId('app-icon')).toBeInTheDocument();
  });

  it('renders icon-background component when name is "icon-background"', () => {
    mockedUseParams.mockReturnValue({ name: 'icon-background' });
    render(<RenderAssetPage />);
    expect(screen.getByTestId('icon-background')).toBeInTheDocument();
  });

  it('renders icon-foreground component when name is "icon-foreground"', () => {
    mockedUseParams.mockReturnValue({ name: 'icon-foreground' });
    render(<RenderAssetPage />);
    expect(screen.getByTestId('icon-foreground')).toBeInTheDocument();
  });

  it('renders splash-dark component when name is "splash-dark"', () => {
    mockedUseParams.mockReturnValue({ name: 'splash-dark' });
    render(<RenderAssetPage />);
    expect(screen.getByTestId('splash-dark')).toBeInTheDocument();
  });

  it('renders splash-light component when name is "splash"', () => {
    mockedUseParams.mockReturnValue({ name: 'splash' });
    render(<RenderAssetPage />);
    expect(screen.getByTestId('splash-light')).toBeInTheDocument();
  });

  it('renders error message for unknown asset name', () => {
    mockedUseParams.mockReturnValue({ name: 'nonexistent' });
    render(<RenderAssetPage />);
    expect(screen.getByText(/unknown asset/i)).toBeInTheDocument();
  });

  it('renders with no margin or padding on the wrapper', () => {
    mockedUseParams.mockReturnValue({ name: 'icon-only' });
    render(<RenderAssetPage />);
    const wrapper = screen.getByTestId('render-asset-wrapper');
    expect(wrapper).toHaveClass('m-0', 'p-0');
  });

  it('hides overflow on wrapper so Playwright captures exact dimensions', () => {
    mockedUseParams.mockReturnValue({ name: 'splash-dark' });
    render(<RenderAssetPage />);
    const wrapper = screen.getByTestId('render-asset-wrapper');
    expect(wrapper).toHaveClass('overflow-hidden');
  });
});
