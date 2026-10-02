import { useWelcomeCatalog } from './use-welcome-catalog';
import type * as React from 'react';

const COMPETITORS = [
  { name: 'ChatGPT Plus', price: 20, note: 'GPT only' },
  { name: 'Claude Pro', price: 20, note: 'Claude only' },
  { name: 'Gemini Advanced', price: 20, note: 'Gemini only' },
] as const;

const SUBSCRIPTION_PRICE = 20;

const ROW = '@max-mkt-cost-stack:flex-wrap @max-mkt-cost-stack:gap-1.5 flex items-center gap-4';
const NAME = '@max-mkt-cost-stack:w-full w-[clamp(7rem,5.6rem+3vw,9rem)] shrink-0 text-sm';
const TRACK =
  'bg-muted/40 relative flex min-h-8 flex-1 items-center justify-end overflow-hidden rounded-md';

/**
 * The welcome page's subscription comparison. The subscription rows are fixed facts and render in
 * the server HTML; the HushBox row is priced from the live catalog in the browser, so the server
 * HTML carries no HushBox figure.
 *
 * E2E state signals (names registered in `TEST_SIGNALS`): once the catalog request has settled the
 * list carries `data-cost-settled="true"`; only a priced HushBox row adds `data-cost-ready`.
 */
export function CostFigures(): React.JSX.Element {
  const catalog = useWelcomeCatalog();

  return (
    <div
      className="@container flex flex-col gap-4"
      data-cost-list
      aria-busy={catalog.status === 'loading' ? true : undefined}
      data-cost-settled={catalog.status === 'loading' ? undefined : 'true'}
      data-cost-ready={catalog.status === 'ready' ? '' : undefined}
    >
      {COMPETITORS.map((competitor) => (
        <div key={competitor.name} className={ROW} data-cost-row>
          <div className={`${NAME} font-medium`} data-cost-name>
            {competitor.name}
          </div>
          <div className={TRACK} data-cost-track>
            <div
              className="bg-foreground-muted/20 absolute inset-y-0 left-0 w-full"
              data-cost-fill
            />
            <div className="text-foreground relative py-1 pr-3 text-right text-xs" data-cost-value>
              ${competitor.price}/mo · {competitor.note}
            </div>
          </div>
        </div>
      ))}

      <div className={ROW} data-cost-row>
        <div className={`${NAME} font-bold`} data-cost-name>
          HushBox
        </div>
        <div className={TRACK} data-cost-track>
          {catalog.status === 'ready' && (
            <div
              className="bg-primary absolute inset-y-0 left-0 rounded-md"
              style={{
                width: `${String(Math.max((catalog.monthlyCost / SUBSCRIPTION_PRICE) * 100, 5))}%`,
              }}
              data-cost-fill
            />
          )}
          <div className="relative py-1 pr-3 text-right text-xs font-bold" data-cost-value>
            {catalog.status === 'ready' && (
              <span className="bg-background" data-cost-ground>
                <span className="bg-muted/40">
                  ${catalog.monthlyCost.toFixed(2)}/mo · ALL {catalog.modelCount}+ models
                </span>
              </span>
            )}
            {catalog.status === 'unavailable' && (
              <span className="text-muted-foreground font-medium">
                Live pricing is unavailable right now.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
