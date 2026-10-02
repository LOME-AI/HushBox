import * as React from 'react';
import { createFileRoute, redirect, useParams } from '@tanstack/react-router';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { env } from '@/lib/platform/env';
import { ASSET_DEFINITIONS } from './-dev-asset-registry';

export const Route = createFileRoute('/dev/render-asset/$name')({
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: RenderAssetPage,
});

function RenderAssetPage(): React.JSX.Element {
  const { name } = useParams({ from: '/dev/render-asset/$name' });
  const AssetComponent = ASSET_DEFINITIONS.find((asset) => asset.name === name)?.component;

  if (!AssetComponent) {
    return (
      <div className="flex h-full items-center justify-center">
        <p>Unknown asset: {name}</p>
      </div>
    );
  }

  return (
    <div data-testid={TEST_IDS.renderAssetWrapper} className="m-0 overflow-hidden p-0">
      <AssetComponent />
    </div>
  );
}
