import { useWelcomeCatalog } from './use-welcome-catalog';
import type * as React from 'react';

/**
 * The providers behind the catalog and its model count, read in the browser from the same request
 * as the cost figures. It carries no reveal of its own: the section shell fades it up, because an
 * attribute the reveal script writes inside an island would differ from the island's hydration.
 *
 * E2E state signals as on the cost figures: `data-cost-settled="true"` once the request settled,
 * `data-cost-ready` only when the providers are shown.
 */
export function ProviderStrip(): React.JSX.Element {
  const catalog = useWelcomeCatalog();

  if (catalog.status === 'loading') {
    return <div className="min-h-20" data-provider-strip aria-busy={true} />;
  }

  if (catalog.status === 'unavailable' || catalog.providers.length === 0) {
    return (
      <p
        className="text-muted-foreground text-center text-sm"
        data-provider-strip
        data-cost-settled="true"
      >
        The model list is unavailable right now.
      </p>
    );
  }

  return (
    <div className="text-center" data-provider-strip data-cost-settled="true" data-cost-ready>
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
        {catalog.providers.map((provider) => (
          <span key={provider} className="text-foreground text-sm font-medium">
            {provider}
          </span>
        ))}
      </div>
      <p className="text-foreground mt-3 text-sm">{catalog.modelCount} models available</p>
    </div>
  );
}
