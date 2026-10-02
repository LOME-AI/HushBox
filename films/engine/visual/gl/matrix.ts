/**
 * A 4×4 matrix in column-major order, as WebGL reads a matrix uniform: element
 * (row, column) sits at `column * 4 + row`.
 */
export type Mat4 = readonly number[];

function at(matrix: Mat4, row: number, column: number): number {
  const value = matrix[column * 4 + row];
  if (value === undefined) {
    throw new RangeError(`a Mat4 holds 16 numbers, and this one holds ${String(matrix.length)}`);
  }
  return value;
}

/** The matrix that applies `b` first and then `a`. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  return Array.from({ length: 16 }, (_, index) => {
    const column = Math.floor(index / 4);
    const row = index % 4;
    let sum = 0;
    for (let k = 0; k < 4; k += 1) {
      sum += at(a, row, k) * at(b, k, column);
    }
    return sum;
  });
}
