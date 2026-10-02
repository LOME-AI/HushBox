import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PortalContainerProvider as PublishedPortalContainerProvider } from '@hushbox/ui';
import { PortalContainerProvider, usePortalContainer } from './portal-container';

function Probe({ container }: Readonly<{ container?: HTMLElement }>): React.JSX.Element {
  const resolved = usePortalContainer(container);
  return <span data-testid="resolved">{resolved?.id ?? 'body'}</span>;
}

function element(id: string): HTMLElement {
  const target = document.createElement('div');
  target.id = id;
  return target;
}

describe('usePortalContainer', () => {
  it('resolves to nothing outside a provider, which a portal reads as the document body', () => {
    render(<Probe />);

    expect(screen.getByTestId('resolved')).toHaveTextContent('body');
  });

  it('resolves to the element the nearest provider gives', () => {
    render(
      <PortalContainerProvider container={element('outer')}>
        <PortalContainerProvider container={element('inner')}>
          <Probe />
        </PortalContainerProvider>
      </PortalContainerProvider>
    );

    expect(screen.getByTestId('resolved')).toHaveTextContent('inner');
  });

  it('resolves to an explicit container over the provider', () => {
    render(
      <PortalContainerProvider container={element('provided')}>
        <Probe container={element('explicit')} />
      </PortalContainerProvider>
    );

    expect(screen.getByTestId('resolved')).toHaveTextContent('explicit');
  });

  it('is published from the package entry', () => {
    expect(PublishedPortalContainerProvider).toBe(PortalContainerProvider);
  });
});
