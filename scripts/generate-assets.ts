import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

interface AssetConfig {
  name: string;
  filename: string;
  renderUrl: string;
  outputWidth: number;
  outputHeight: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

/** Asset definitions matching the React components in native-assets/. */
export function getAssetConfigs(): AssetConfig[] {
  return [
    {
      name: 'icon-only',
      filename: 'icon-only.png',
      renderUrl: '/dev/render-asset/icon-only',
      outputWidth: 1024,
      outputHeight: 1024,
      cssWidth: 512,
      cssHeight: 512,
      dpr: 2,
    },
    {
      name: 'icon-background',
      filename: 'icon-background.png',
      renderUrl: '/dev/render-asset/icon-background',
      outputWidth: 1024,
      outputHeight: 1024,
      cssWidth: 512,
      cssHeight: 512,
      dpr: 2,
    },
    {
      name: 'icon-foreground',
      filename: 'icon-foreground.png',
      renderUrl: '/dev/render-asset/icon-foreground',
      outputWidth: 1024,
      outputHeight: 1024,
      cssWidth: 512,
      cssHeight: 512,
      dpr: 2,
    },
    {
      name: 'splash-dark',
      filename: 'splash-dark.png',
      renderUrl: '/dev/render-asset/splash-dark',
      outputWidth: 2732,
      outputHeight: 2732,
      cssWidth: 1366,
      cssHeight: 1366,
      dpr: 2,
    },
    {
      name: 'splash',
      filename: 'splash.png',
      renderUrl: '/dev/render-asset/splash',
      outputWidth: 2732,
      outputHeight: 2732,
      cssWidth: 1366,
      cssHeight: 1366,
      dpr: 2,
    },
  ];
}

/** Path where generated PNGs are saved (gitignored). */
export function getOutputPath(rootDir: string, filename: string): string {
  return path.join(rootDir, 'apps', 'web', 'resources', 'generated', filename);
}

/** Path where PNGs are copied for Vite static serving during dev (gitignored). */
export function getDevAssetPath(rootDir: string, filename: string): string {
  return path.join(rootDir, 'apps', 'web', 'public', 'dev-assets', filename);
}

const DEV_SERVER_URL = 'http://localhost:5173';

/**
 * Generate all native asset PNGs using Playwright.
 * Requires the Vite dev server to be running on port 5173.
 */
export async function generateAssets(rootDir: string): Promise<void> {
  // Dynamic import to avoid pulling Playwright into the bundle for non-generation scripts
  const { chromium } = await import('playwright');

  const configs = getAssetConfigs();

  // Ensure output directories exist
  const generatedDir = path.join(rootDir, 'apps', 'web', 'resources', 'generated');
  const devAssetsDir = path.join(rootDir, 'apps', 'web', 'public', 'dev-assets');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(devAssetsDir, { recursive: true });

  const browser = await chromium.launch();

  try {
    for (const config of configs) {
      console.log(
        `Generating ${config.filename} (${String(config.outputWidth)}x${String(config.outputHeight)} @ ${String(config.dpr)}x)...`
      );

      const context = await browser.newContext({
        viewport: { width: config.cssWidth, height: config.cssHeight },
        deviceScaleFactor: config.dpr,
      });
      const page = await context.newPage();

      await page.goto(`${DEV_SERVER_URL}${config.renderUrl}`, {
        waitUntil: 'networkidle',
      });

      const outputPath = getOutputPath(rootDir, config.filename);
      await page.screenshot({ path: outputPath, fullPage: false });

      // Copy to public/dev-assets for Vite static serving
      const devPath = getDevAssetPath(rootDir, config.filename);
      copyFileSync(outputPath, devPath);

      await context.close();
      console.log(`  -> ${config.filename}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`Generated ${String(configs.length)} assets`);
}

/**
 * Generate a single asset by name. Used for file-watcher incremental updates.
 */
export async function generateSingleAsset(rootDir: string, assetName: string): Promise<void> {
  const configs = getAssetConfigs();
  const config = configs.find((c) => c.name === assetName);
  if (!config) {
    throw new Error(`Unknown asset: ${assetName}`);
  }

  const { chromium } = await import('playwright');

  const generatedDir = path.join(rootDir, 'apps', 'web', 'resources', 'generated');
  const devAssetsDir = path.join(rootDir, 'apps', 'web', 'public', 'dev-assets');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(devAssetsDir, { recursive: true });

  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({
      viewport: { width: config.cssWidth, height: config.cssHeight },
      deviceScaleFactor: config.dpr,
    });
    const page = await context.newPage();

    await page.goto(`${DEV_SERVER_URL}${config.renderUrl}`, {
      waitUntil: 'networkidle',
    });

    const outputPath = getOutputPath(rootDir, config.filename);
    await page.screenshot({ path: outputPath, fullPage: false });

    const devPath = getDevAssetPath(rootDir, config.filename);
    copyFileSync(outputPath, devPath);

    await context.close();
  } finally {
    await browser.close();
  }

  console.log(`Generated ${config.filename}`);
}

// CLI entry point
/* v8 ignore next 2 */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  /* v8 ignore next 9 */
  const assetName = process.argv[2];
  const rootDir = process.cwd();
  const action = assetName ? generateSingleAsset(rootDir, assetName) : generateAssets(rootDir);
  try {
    await action;
  } catch (error: unknown) {
    console.error('Asset generation failed:', error);
    process.exit(1);
  }
}
