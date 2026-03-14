import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AssetsPage,
  ASSET_DEFINITIONS,
  SCREENSHOT_DEFINITIONS,
  RESOLUTION_DEFINITIONS,
} from './dev.assets';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  redirect: (options: Record<string, unknown>) => options,
}));

describe('AssetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page title', () => {
    render(<AssetsPage />);
    expect(screen.getByText('Native Assets')).toBeInTheDocument();
  });

  it('renders the asset count', () => {
    render(<AssetsPage />);
    expect(screen.getByText(`${String(ASSET_DEFINITIONS.length)} assets`)).toBeInTheDocument();
  });

  it('renders a card for each asset definition', () => {
    render(<AssetsPage />);
    for (const asset of ASSET_DEFINITIONS) {
      expect(screen.getByTestId(`asset-card-${asset.name}`)).toBeInTheDocument();
    }
  });

  it('shows asset labels', () => {
    render(<AssetsPage />);
    for (const asset of ASSET_DEFINITIONS) {
      expect(screen.getByText(asset.label)).toBeInTheDocument();
    }
  });

  it('shows asset dimensions inside each card', () => {
    render(<AssetsPage />);
    for (const asset of ASSET_DEFINITIONS) {
      const card = screen.getByTestId(`asset-card-${asset.name}`);
      expect(card).toHaveTextContent(`${String(asset.width)} × ${String(asset.height)}`);
    }
  });

  it('renders preview images from generated PNGs', () => {
    render(<AssetsPage />);
    for (const asset of ASSET_DEFINITIONS) {
      const img = screen.getByTestId(`asset-preview-${asset.name}`);
      expect(img.tagName).toBe('IMG');
      expect(img).toHaveAttribute('src', `/dev-assets/${asset.name}.png`);
    }
  });

  it('renders "Open component" links to render routes for each asset', () => {
    render(<AssetsPage />);
    for (const asset of ASSET_DEFINITIONS) {
      const link = screen.getByTestId(`asset-link-${asset.name}`);
      expect(link).toHaveAttribute('href', `/dev/render-asset/${asset.name}`);
      expect(link).toHaveTextContent('Open component');
    }
  });

  it('renders "Open image" buttons for each asset', () => {
    render(<AssetsPage />);
    for (const asset of ASSET_DEFINITIONS) {
      const card = screen.getByTestId(`asset-card-${asset.name}`);
      const button = card.querySelector('[data-testid="asset-open-image-' + asset.name + '"]');
      expect(button).not.toBeNull();
      expect(button).toHaveTextContent('Open image');
    }
  });

  it('defines exactly 5 assets', () => {
    expect(ASSET_DEFINITIONS).toHaveLength(5);
  });

  it('includes icon assets at 1024x1024', () => {
    const iconAssets = ASSET_DEFINITIONS.filter((a) => a.width === 1024);
    expect(iconAssets).toHaveLength(3);
    for (const asset of iconAssets) {
      expect(asset.height).toBe(1024);
    }
  });

  it('includes splash assets at 2732x2732', () => {
    const splashAssets = ASSET_DEFINITIONS.filter((a) => a.width === 2732);
    expect(splashAssets).toHaveLength(2);
    for (const asset of splashAssets) {
      expect(asset.height).toBe(2732);
    }
  });

  it('renders the Store Screenshots heading', () => {
    render(<AssetsPage />);
    expect(screen.getByText('Store Screenshots')).toBeInTheDocument();
  });

  it('defines exactly 6 screenshots', () => {
    expect(SCREENSHOT_DEFINITIONS).toHaveLength(6);
  });

  it('defines exactly 4 resolutions', () => {
    expect(RESOLUTION_DEFINITIONS).toHaveLength(4);
  });

  it('renders resolution group headings', () => {
    render(<AssetsPage />);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      expect(screen.getByText(resolution.label)).toBeInTheDocument();
    }
  });

  it('renders screenshot cards for each resolution and screenshot', () => {
    render(<AssetsPage />);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      for (const screenshot of SCREENSHOT_DEFINITIONS) {
        expect(
          screen.getByTestId(`screenshot-card-${resolution.name}-${screenshot.name}`)
        ).toBeInTheDocument();
      }
    }
  });

  it('renders screenshot images with correct src paths', () => {
    render(<AssetsPage />);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      for (const screenshot of SCREENSHOT_DEFINITIONS) {
        const card = screen.getByTestId(`screenshot-card-${resolution.name}-${screenshot.name}`);
        const img = card.querySelector('img');
        expect(img).not.toBeNull();
        expect(img).toHaveAttribute(
          'src',
          `/dev-assets/screenshots/${resolution.name}/${screenshot.name}.png`
        );
      }
    }
  });

  it('shows resolution dimensions in each group', () => {
    render(<AssetsPage />);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      const group = screen.getByTestId(`resolution-group-${resolution.name}`);
      expect(group).toHaveTextContent(`${String(resolution.width)} × ${String(resolution.height)}`);
    }
  });

  it('renders "Open image" buttons for each screenshot card', () => {
    render(<AssetsPage />);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      for (const screenshot of SCREENSHOT_DEFINITIONS) {
        const card = screen.getByTestId(`screenshot-card-${resolution.name}-${screenshot.name}`);
        const button = card.querySelector(
          `[data-testid="screenshot-open-image-${resolution.name}-${screenshot.name}"]`
        );
        expect(button).not.toBeNull();
        expect(button).toHaveTextContent('Open image');
      }
    }
  });

  it('opens image preview dialog when asset "Open image" is clicked', async () => {
    const user = userEvent.setup();
    render(<AssetsPage />);
    const firstAsset = ASSET_DEFINITIONS[0]!;
    const button = screen.getByTestId(`asset-open-image-${firstAsset.name}`);
    await user.click(button);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const img = dialog.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', `/dev-assets/${firstAsset.name}.png`);
  });

  it('opens image preview dialog when screenshot "Open image" is clicked', async () => {
    const user = userEvent.setup();
    render(<AssetsPage />);
    const firstResolution = RESOLUTION_DEFINITIONS[0]!;
    const firstScreenshot = SCREENSHOT_DEFINITIONS[0]!;
    const button = screen.getByTestId(
      `screenshot-open-image-${firstResolution.name}-${firstScreenshot.name}`
    );
    await user.click(button);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const img = dialog.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute(
      'src',
      `/dev-assets/screenshots/${firstResolution.name}/${firstScreenshot.name}.png`
    );
  });

  it('shows image label in the dialog title', async () => {
    const user = userEvent.setup();
    render(<AssetsPage />);
    const firstAsset = ASSET_DEFINITIONS[0]!;
    const button = screen.getByTestId(`asset-open-image-${firstAsset.name}`);
    await user.click(button);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(firstAsset.label);
  });

  it('does not show image preview dialog initially', () => {
    render(<AssetsPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
