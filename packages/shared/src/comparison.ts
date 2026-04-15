export interface ComparisonRow {
  readonly label: string;
  readonly hushbox: boolean;
  readonly others: boolean;
}

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  { label: 'You hold the encryption key', hushbox: true, others: false },
  { label: "Provider can't read stored chats", hushbox: true, others: false },
  { label: 'Password never sent to server', hushbox: true, others: false },
  { label: 'Zero data retention', hushbox: true, others: false },
  { label: 'Anonymous requests', hushbox: true, others: false },
  { label: 'Open source', hushbox: true, others: false },
  { label: 'Transparent pricing', hushbox: true, others: false },
] as const;
