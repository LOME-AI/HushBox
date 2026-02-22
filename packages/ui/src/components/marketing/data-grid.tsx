import * as React from 'react';
import { cn } from '../../lib/utilities';

interface DataGridRow {
  label: string;
  values: string[];
}

interface DataGridProps extends React.ComponentProps<'div'> {
  columns: string[];
  rows: DataGridRow[];
  highlightColumn?: number;
  animated?: boolean;
}

function DataGrid({
  columns,
  rows,
  highlightColumn,
  animated = false,
  className,
  ...props
}: Readonly<DataGridProps>): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (!animated) return;
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [animated]);

  return (
    <div
      ref={containerRef}
      data-slot="data-grid"
      {...(highlightColumn !== undefined && {
        'data-highlight-column': String(highlightColumn),
      })}
      {...(animated && { 'data-animated': '' })}
      {...(animated && { 'data-visible': String(visible) })}
      className={cn('overflow-x-auto', className)}
      {...props}
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((col, colIndex) => (
              <th
                key={col}
                className={cn(
                  'border-b px-4 py-2 text-left font-semibold',
                  highlightColumn !== undefined &&
                    colIndex === highlightColumn &&
                    'bg-primary/10 text-primary'
                )}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={row.label}
              {...(animated && {
                style: { '--row-delay': `${String(rowIndex * 100)}ms` } as React.CSSProperties,
              })}
            >
              <td className="border-b px-4 py-2 font-medium">{row.label}</td>
              {row.values.map((value, valueIndex) => {
                const colIndex = valueIndex + 1;
                const isHighlighted = highlightColumn !== undefined && colIndex === highlightColumn;
                return (
                  <td
                    key={valueIndex}
                    className={cn(
                      'border-b px-4 py-2',
                      isHighlighted && 'bg-primary/10 text-primary font-semibold'
                    )}
                  >
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { DataGrid, type DataGridProps, type DataGridRow };
