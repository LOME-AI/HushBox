export function at<T>(array: T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`Expected value at index ${String(index)}`);
  return value;
}
