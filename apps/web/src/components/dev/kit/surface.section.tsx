import * as React from 'react';
import { Button } from '@hushbox/ui';
import {
  AsyncRegion,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  type SkeletonShape,
} from '@hushbox/ui/surface';
import type { KitSection } from './kit-sections';

const DEPOSITS = [
  { date: '2026-09-18', type: 'Deposit', amount: '+$25.00' },
  { date: '2026-09-02', type: 'Deposit', amount: '+$10.00' },
  { date: '2026-08-14', type: 'Deposit', amount: '+$10.00' },
] as const;

const ISSUES = [
  { subject: 'September product notes', status: 'sent', recipients: '1,204' },
  { subject: 'Read-aloud everywhere', status: 'scheduled', recipients: '1,211' },
] as const;

const USAGE_PLACEHOLDER: readonly SkeletonShape[] = [
  { kind: 'line', width: '40%' },
  { kind: 'line', width: '90%' },
  { kind: 'line', width: '75%' },
  { kind: 'block', height: 'md' },
];

function Sample({
  name,
  children,
}: Readonly<{ name: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-caption text-muted-foreground font-mono">{name}</p>
      {children}
    </div>
  );
}

/** A failed read whose retry puts it back to loading, as a real retry would. */
function FailedRead(): React.JSX.Element {
  const [status, setStatus] = React.useState<'pending' | 'error'>('error');
  return (
    <AsyncRegion
      status={status}
      label="Usage after a failed read"
      placeholder={USAGE_PLACEHOLDER}
      error={{
        message: "Couldn't load your usage.",
        onRetry: () => {
          setStatus('pending');
        },
      }}
    >
      {null}
    </AsyncRegion>
  );
}

function SurfaceSamples(): React.JSX.Element {
  return (
    <>
      <Sample name="card">
        <Card>
          <CardHeader>
            <CardTitle level={3}>Current Balance</CardTitle>
            <CardDescription>Your available credits for AI model usage</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-4xl font-bold tabular-nums">$12.48</p>
              <Button size="lg">Add Credits</Button>
            </div>
          </CardContent>
        </Card>
      </Sample>
      <Sample name="table, comfortable">
        <Table caption="Purchase history" captionHidden>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Date</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell numeric>Amount</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {DEPOSITS.map((deposit) => (
              <TableRow key={deposit.date}>
                <TableHeaderCell>{deposit.date}</TableHeaderCell>
                <TableCell>{deposit.type}</TableCell>
                <TableCell numeric>{deposit.amount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Sample>
      <Sample name="table, dense">
        <Table density="dense" caption="Newsletter issues">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Subject</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell numeric>Recipients</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {ISSUES.map((issue) => (
              <TableRow key={issue.subject}>
                <TableCell>{issue.subject}</TableCell>
                <TableCell className="font-mono">{issue.status}</TableCell>
                <TableCell numeric>{issue.recipients}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Sample>
      <Sample name="async region, pending">
        <AsyncRegion status="pending" label="Usage while loading" placeholder={USAGE_PLACEHOLDER}>
          {null}
        </AsyncRegion>
      </Sample>
      <Sample name="async region, error">
        <FailedRead />
      </Sample>
    </>
  );
}

const section: KitSection = {
  title: 'Surfaces',
  part: 5,
  render: () => <SurfaceSamples />,
};

export default section;
