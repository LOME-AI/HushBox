import {
  charStorageDollars,
  FEE_BUCKET_BY_ID,
  FEE_CATEGORIES,
  roundPreservingSum,
  type FeeBucketId,
  type FeeCategoryId,
} from '@hushbox/shared';

export type CostCategoryId = 'serviceValue' | 'transactionCosts' | 'platformFee';

export type CostItemId = 'model-usage' | 'storage' | FeeCategoryId;

export interface CostShareItem {
  readonly id: CostItemId;
  readonly label: string;
  /** Percent of the deposit, unrounded. */
  readonly percentage: number;
}

export interface CostCategoryShare {
  readonly id: CostCategoryId;
  readonly name: string;
  /** Percent of the deposit, unrounded: the ring's slice size. */
  readonly percentage: number;
  /** Whole percent, rounded with the other categories' so the three add to 100. */
  readonly roundedPercentage: number;
  /** `~N%` for {@link roundedPercentage}. */
  readonly approximateLabel: string;
  readonly items: readonly CostShareItem[];
}

export interface CostCategoryShares {
  /** The first of {@link categories}, which the ring's centre names. */
  readonly serviceValue: CostCategoryShare;
  readonly categories: readonly CostCategoryShare[];
}

const DEFAULT_ESTIMATED_CHARACTERS = 1_000_000;

function feeItems(bucket: FeeBucketId): CostShareItem[] {
  // Category labels are authored in sentence-flow casing so the terms-of-service
  // clause reads as one sentence; this list needs an initial capital instead.
  return FEE_CATEGORIES.filter((c) => FEE_BUCKET_BY_ID[c.id] === bucket).map((c) => ({
    id: c.id,
    label: c.label.charAt(0).toUpperCase() + c.label.slice(1),
    percentage: c.rate * 100,
  }));
}

function sumOf(items: readonly CostShareItem[]): number {
  return items.reduce((sum, item) => sum + item.percentage, 0);
}

function share(
  id: CostCategoryId,
  name: string,
  items: readonly CostShareItem[],
  rounded: number | undefined
): CostCategoryShare {
  // `roundPreservingSum` returns one value per input, so `rounded` is always present.
  const roundedPercentage = Number(rounded);
  return {
    id,
    name,
    percentage: sumOf(items),
    roundedPercentage,
    approximateLabel: `~${String(roundedPercentage)}%`,
    items,
  };
}

/**
 * How a deposit divides between what the user buys, what the payment and the
 * gateway cost, and HushBox's margin. The fee list and the ring both draw from
 * this one result, so their figures cannot disagree.
 */
export function costCategoryShares(
  depositAmount: number,
  estimatedCharacters = DEFAULT_ESTIMATED_CHARACTERS
): CostCategoryShares {
  if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
    throw new RangeError(`a deposit of ${String(depositAmount)} has no cost shares`);
  }

  const totalFeesRate = FEE_CATEGORIES.reduce((sum, c) => sum + c.rate, 0);
  const totalFees = depositAmount * totalFeesRate;
  const storageFee = charStorageDollars(estimatedCharacters);
  const modelUsage = depositAmount - totalFees - storageFee;

  const serviceValueItems: CostShareItem[] = [
    { id: 'model-usage', label: 'Model usage', percentage: (modelUsage / depositAmount) * 100 },
    { id: 'storage', label: 'Storage', percentage: (storageFee / depositAmount) * 100 },
  ];
  const transactionCostsItems = feeItems('transaction-costs');
  const platformFeeItems = feeItems('platform-fee');

  // Largest-remainder rounding so the three approximate labels add to 100%.
  const [serviceValueRounded, transactionCostsRounded, platformFeeRounded] = roundPreservingSum([
    sumOf(serviceValueItems),
    sumOf(transactionCostsItems),
    sumOf(platformFeeItems),
  ]);

  const serviceValue = share(
    'serviceValue',
    'Service Value',
    serviceValueItems,
    serviceValueRounded
  );
  const categories = [
    serviceValue,
    share('transactionCosts', 'Transaction Costs', transactionCostsItems, transactionCostsRounded),
    share('platformFee', 'Platform Fee', platformFeeItems, platformFeeRounded),
    // A bucket whose every fee rate is zero has no items and is not shown.
  ].filter((category) => category.items.length > 0);

  return { serviceValue, categories };
}
