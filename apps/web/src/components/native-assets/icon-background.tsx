import * as React from 'react';

export function IconBackground(): React.JSX.Element {
  return (
    <div
      data-testid="icon-background"
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#0a0a0a',
      }}
    />
  );
}
