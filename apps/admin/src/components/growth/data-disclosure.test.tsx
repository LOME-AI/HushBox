import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DataDisclosure } from './data-disclosure.js';

function renderDisclosure(): ReturnType<typeof render> {
  return render(
    <DataDisclosure
      label="Visitors week by week"
      table={
        <table>
          <caption>Visitors week by week</caption>
          <thead>
            <tr>
              <th scope="col">Visitors</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>12</td>
            </tr>
          </tbody>
        </table>
      }
    />
  );
}

describe('DataDisclosure', () => {
  it('renders the table on every pass, hidden only from the eye', () => {
    const { container } = renderDisclosure();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="chart-data-table"]')).toHaveClass('sr-only');
  });

  it('shows the table when the control is pressed', async () => {
    const { container } = renderDisclosure();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(container.querySelector('[data-slot="chart-data-table"]')).not.toHaveClass('sr-only');
  });

  it('hides the table again when the control is pressed a second time', async () => {
    const { container } = renderDisclosure();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide data' }));
    expect(container.querySelector('[data-slot="chart-data-table"]')).toHaveClass('sr-only');
  });

  it('says through the control whether the table is showing', async () => {
    renderDisclosure();
    const control = screen.getByRole('button', { name: 'Show data' });
    expect(control).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(control);
    expect(screen.getByRole('button', { name: 'Hide data' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});

describe('DataDisclosure scroll region', () => {
  it('scrolls the shown table inside a box a keyboard can reach, named by the label it was given', async () => {
    renderDisclosure();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    const region = screen.getByRole('group', { name: 'Visitors week by week' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });

  // The table's rules run to the box's edge, so a rounded box would clip their ends.
  it('keeps the shown box square, so its corners cut nothing the table draws', async () => {
    renderDisclosure();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getByRole('group', { name: 'Visitors week by week' }).className).not.toMatch(
      /(^|\s)rounded(-|\s|$)/
    );
  });

  it('keeps the hidden table out of the tab order', () => {
    const { container } = renderDisclosure();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="chart-data-table"]')).not.toHaveAttribute(
      'tabindex'
    );
  });

  // Chromium makes a scroller whose content overflows it keyboard-focusable
  // whatever its tabindex, and the hidden box is one pixel holding a whole table,
  // so an overflow class on it would put an unseen stop in the tab order.
  it('gives the hidden box no overflow class, which would make it a focusable scroller', () => {
    const { container } = renderDisclosure();
    const hidden = container.querySelector('[data-slot="chart-data-table"]');
    expect(hidden?.className).not.toMatch(/\boverflow-/);
  });
});
