import * as React from 'react';
import { Badge } from '@hushbox/ui';
import type { Model } from '@hushbox/shared';
import { formatNumber, formatPriceRange, isExpensiveModel } from '@hushbox/shared';
import { applyFees, formatPricePer1k } from '../../lib/format';

const CAPABILITY_DISPLAY_NAMES: Record<string, string> = {
  'internet-search': 'Internet Search',
};

interface ModelInfoPanelProps {
  model: Model;
  compact?: boolean;
}

function AutoRouterPanel({
  model,
  compact,
}: Readonly<{ model: Model; compact: boolean }>): React.JSX.Element {
  const valueClass = compact ? 'text-sm font-medium' : 'text-lg font-medium';

  return (
    <div className={compact ? 'space-y-3' : 'space-y-6'}>
      {!compact && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            How It Works
          </div>
          <div className="text-sm">
            Analyzes each message and picks the best model automatically. Simple questions use
            affordable models. Complex tasks get the most capable models.
          </div>
        </div>
      )}

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Input Price Range
        </div>
        <div className={valueClass}>
          {model.minPricePerInputToken !== undefined && model.maxPricePerInputToken !== undefined
            ? formatPriceRange(
                applyFees(model.minPricePerInputToken),
                applyFees(model.maxPricePerInputToken)
              )
            : 'Varies'}
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Output Price Range
        </div>
        <div className={valueClass}>
          {model.minPricePerOutputToken !== undefined && model.maxPricePerOutputToken !== undefined
            ? formatPriceRange(
                applyFees(model.minPricePerOutputToken),
                applyFees(model.maxPricePerOutputToken)
              )
            : 'Varies'}
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Capacity Limit
        </div>
        <div className={valueClass}>{formatNumber(model.contextLength)} tokens</div>
      </div>
    </div>
  );
}

function StandardPanel({
  model,
  compact,
}: Readonly<{ model: Model; compact: boolean }>): React.JSX.Element {
  const valueClass = compact ? 'text-sm font-medium' : 'text-lg font-medium';

  return (
    <div className={compact ? 'space-y-3' : 'space-y-6'}>
      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">Provider</div>
        <div className={`${valueClass} break-words`}>{model.provider}</div>
      </div>

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Input Price / Token
        </div>
        <div className={valueClass}>
          {formatPricePer1k(applyFees(model.pricePerInputToken))} / 1k
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Output Price / Token
        </div>
        <div className={valueClass}>
          {formatPricePer1k(applyFees(model.pricePerOutputToken))} / 1k
        </div>
      </div>

      {!compact && isExpensiveModel(model.pricePerInputToken, model.pricePerOutputToken) && (
        <p className="-mt-6 mb-1 text-sm text-amber-500" data-testid="expensive-model-warning">
          Long chats with this model can be costly
        </p>
      )}

      <div>
        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
          Capacity Limit
        </div>
        <div className={valueClass}>{formatNumber(model.contextLength)} tokens</div>
      </div>

      {model.capabilities.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
            Capabilities
          </div>
          <div className="flex flex-wrap gap-2">
            {model.capabilities.map((cap) => (
              <Badge key={cap} variant="secondary">
                {CAPABILITY_DISPLAY_NAMES[cap] ?? cap}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {!compact && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            Description
          </div>
          <div className="overflow-hidden text-sm break-words">{model.description}</div>
        </div>
      )}
    </div>
  );
}

export function ModelInfoPanel({
  model,
  compact = false,
}: Readonly<ModelInfoPanelProps>): React.JSX.Element {
  if (model.isAutoRouter === true) {
    return <AutoRouterPanel model={model} compact={compact} />;
  }
  return <StandardPanel model={model} compact={compact} />;
}
