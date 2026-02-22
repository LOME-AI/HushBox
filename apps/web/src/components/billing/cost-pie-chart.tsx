import * as React from 'react';
import {
  HUSHBOX_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
} from '@hushbox/shared';

interface CostPieChartProps {
  /** The deposit amount in USD */
  depositAmount: number;
  /** Estimated characters used (for storage fee calculation) */
  estimatedCharacters?: number;
}

interface PieSlice {
  label: string;
  value: number;
  color: string;
  testId: string;
}

// Explicit colors for categories
const COLORS = {
  SERVICE_VALUE: '#3b82f6', // Blue
  TRANSACTION_COSTS: '#f59e0b', // Amber
  PLATFORM_FEE: '#ec4755', // brand red
};

interface ArcParams {
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  endAngle: number;
}

function describeArc(params: ArcParams): string {
  const { cx, cy, radius, startAngle, endAngle } = params;
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return [
    'M',
    cx,
    cy,
    'L',
    start.x,
    start.y,
    'A',
    radius,
    radius,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y,
    'Z',
  ].join(' ');
}

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

export function CostPieChart({
  depositAmount,
  estimatedCharacters = 1_000_000,
}: Readonly<CostPieChartProps>): React.JSX.Element {
  const hushboxFee = depositAmount * HUSHBOX_FEE_RATE;
  const ccFee = depositAmount * CREDIT_CARD_FEE_RATE;
  const providerFee = depositAmount * PROVIDER_FEE_RATE;
  const storageFee = estimatedCharacters * STORAGE_COST_PER_CHARACTER;
  const modelUsage = depositAmount - hushboxFee - ccFee - providerFee - storageFee;

  // Group into 3 categories
  const serviceValue = modelUsage + storageFee;
  const transactionCosts = ccFee + providerFee;
  const platformFee = hushboxFee;

  const slices: PieSlice[] = [
    {
      label: 'Service Value',
      value: serviceValue,
      color: COLORS.SERVICE_VALUE,
      testId: 'slice-service-value',
    },
    {
      label: 'Transaction Costs',
      value: transactionCosts,
      color: COLORS.TRANSACTION_COSTS,
      testId: 'slice-transaction-costs',
    },
    {
      label: 'Platform Fee',
      value: platformFee,
      color: COLORS.PLATFORM_FEE,
      testId: 'slice-platform-fee',
    },
  ];

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const cx = 100;
  const cy = 100;
  const radius = 80;

  let currentAngle = 0;

  return (
    <div data-testid="cost-pie-chart" className="flex items-center justify-center">
      {/* SVG Pie Chart - no legend, no center text */}
      <svg width="240" height="240" viewBox="0 0 200 200" className="flex-shrink-0">
        {slices.map((slice) => {
          const sliceAngle = (slice.value / total) * 360;
          const startAngle = currentAngle;
          const endAngle = currentAngle + sliceAngle;
          currentAngle = endAngle;

          // Skip if slice is too small
          if (sliceAngle < 0.5) return null;

          return (
            <path
              key={slice.testId}
              data-testid={slice.testId}
              d={describeArc({ cx, cy, radius, startAngle, endAngle })}
              fill={slice.color}
              stroke="hsl(var(--background))"
              strokeWidth="2"
            />
          );
        })}
        {/* Center hole for donut effect - transparent to show background */}
        <circle cx={cx} cy={cy} r={40} fill="transparent" />
      </svg>
    </div>
  );
}
