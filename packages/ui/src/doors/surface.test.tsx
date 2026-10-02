import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AsyncRegion,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@hushbox/ui/surface';

describe('@hushbox/ui/surface', () => {
  it('draws a card whose title is a heading', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle level={2}>Current Balance</CardTitle>
          <CardDescription>Credit never expires.</CardDescription>
        </CardHeader>
        <CardContent>$12.48</CardContent>
      </Card>
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Current Balance' })).toBeInTheDocument();
  });

  it('draws a table from its parts', () => {
    render(
      <Table caption="Purchase history">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Date</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>2026-09-18</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );

    expect(screen.getByRole('table', { name: 'Purchase history' })).toBeInTheDocument();
  });

  it('draws an async region', () => {
    render(
      <AsyncRegion status="ready" label="Purchase history" placeholder={[]}>
        <p>Deposits</p>
      </AsyncRegion>
    );

    expect(screen.getByRole('group', { name: 'Purchase history' })).toHaveTextContent('Deposits');
  });

  it('draws an empty state', () => {
    render(<EmptyState title="No purchases yet" />);

    expect(screen.getByText('No purchases yet')).toBeInTheDocument();
  });
});
