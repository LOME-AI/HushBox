/** An English list: "A", "A and B", "A, B and C", with no serial comma. */
export function joinWithAnd(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.slice(-1).join('')}`;
}
