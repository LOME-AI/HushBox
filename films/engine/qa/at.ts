/**
 * The value at an index the caller has bounded by the array's length; an index
 * outside it is a defect in the caller, refused naming the index.
 */
export function at(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`index ${String(index)} lies outside ${String(values.length)} values`);
  }
  return value;
}
