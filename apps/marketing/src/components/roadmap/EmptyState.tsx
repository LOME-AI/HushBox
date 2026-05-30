import * as React from 'react';

interface EmptyStateProps {
  readonly onReset: () => void;
}

/**
 * Shown when the current filter combination yields zero matching
 * projects. Provides a single way out: reset filters to defaults
 * (all chips on, URL cleared).
 */
export function EmptyState({ onReset }: EmptyStateProps): React.JSX.Element {
  return (
    <div
      data-roadmap-empty
      className="border-border bg-background-subtle/40 flex flex-col items-center gap-4 rounded-lg border px-6 py-12 text-center"
    >
      <p className="text-foreground text-base">No projects match your filters.</p>
      <button
        type="button"
        onClick={onReset}
        className="border-border hover:bg-background-subtle text-foreground inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium transition-colors"
      >
        Reset filters
      </button>
    </div>
  );
}
