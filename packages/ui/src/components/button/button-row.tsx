import * as React from 'react';

import { buttonLabelsRowClass, buttonRowClass } from './button-group-classes';
import { labelledButtons, measureButtonGroups } from './measure-button-groups';

interface ButtonRowProps {
  children: React.ReactNode;
  stack?: 'space' | 'labels';
  stackedOrder?: 'same' | 'reverse';
}

/** Whether the row's labelled buttons sit on more than one line. */
function isStacked(row: HTMLElement): boolean {
  const tops = labelledButtons(row).map((child) => child.offsetTop);
  return new Set(tops).size > 1;
}

/**
 * Buttons side by side at equal widths, laid out by the row's space (`stack="space"`) or
 * by whether the widest label fits an equal share (`stack="labels"`). With
 * `stackedOrder="reverse"` a stacked row renders its buttons in reverse, so the order a
 * keyboard or screen reader meets them is the order they are drawn in. The measure marks
 * the root `data-wrap-labels`, so a row whose labels crowd it stacks and every button
 * inside it wraps a label too long for its width.
 */
function ButtonRow({
  children,
  stack = 'space',
  stackedOrder = 'same',
}: Readonly<ButtonRowProps>): React.JSX.Element {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = React.useState(false);
  const reverses = stackedOrder === 'reverse';

  React.useLayoutEffect(() => {
    const row = rowRef.current;
    // A layout effect runs once the ref is attached, so the root is always there.
    /* v8 ignore next */
    if (row === null) return;
    return measureButtonGroups(row);
  }, []);

  React.useLayoutEffect(() => {
    const row = rowRef.current;
    /* v8 ignore next */
    if (row === null) return;
    if (!reverses) return;
    const update = (): void => {
      setStacked(isStacked(row));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      observer.disconnect();
    };
  }, [reverses]);

  const items = React.Children.toArray(children);
  return (
    <div ref={rowRef} className={stack === 'labels' ? buttonLabelsRowClass : buttonRowClass}>
      {reverses && stacked ? items.toReversed() : items}
    </div>
  );
}

export { ButtonRow, type ButtonRowProps };
