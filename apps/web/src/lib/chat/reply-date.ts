function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * A reply's date as its footer shows it: "Today" on the viewer's current local day,
 * otherwise the local calendar date as `YYYY-MM-DD`.
 */
export function formatReplyDate(createdAt: string, now: Date): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    throw new RangeError('A reply date needs a parseable instant');
  }
  const year = created.getFullYear();
  const month = created.getMonth();
  const day = created.getDate();
  if (year === now.getFullYear() && month === now.getMonth() && day === now.getDate()) {
    return 'Today';
  }
  return `${String(year)}-${twoDigits(month + 1)}-${twoDigits(day)}`;
}
