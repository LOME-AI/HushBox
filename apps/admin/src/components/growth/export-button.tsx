import * as React from 'react';
import { Button } from '@hushbox/ui';
import { toCsv, type CsvColumn, type CsvExtent } from './csv.js';

interface ExportButtonProps<T> {
  /** Becomes the downloaded file's name, so it says which panel it came from. */
  readonly name: string;
  /** What the rows handed over cover, which the file states above them. */
  readonly extent: CsvExtent;
  readonly columns: readonly CsvColumn<T>[];
  readonly rows: readonly T[];
}

/**
 * Per-panel CSV export. The file is built and handed over in the click that
 * asked for it: the rows are already in memory, so writing one costs no read
 * against the operations budget.
 */
export function ExportButton<T>({
  name,
  extent,
  columns,
  rows,
}: Readonly<ExportButtonProps<T>>): React.JSX.Element {
  const download = (): void => {
    const blob = new Blob([toCsv({ name, extent, columns, rows })], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button size="sm" variant="outline" onClick={download}>
      Export CSV
    </Button>
  );
}
