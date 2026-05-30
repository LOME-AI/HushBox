import * as React from 'react';

export function IconBackground(): React.JSX.Element {
  return (
    <div
      data-testid="icon-background"
      style={{
        width: '100vw',
        height: '100vh',
        // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
        backgroundColor: '#0a0a0a',
      }}
    />
  );
}
