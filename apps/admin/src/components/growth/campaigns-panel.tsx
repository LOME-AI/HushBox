import * as React from 'react';
import { z } from 'zod';
import { Button, CopyableId, ScrollRegion } from '@hushbox/ui';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { CAMPAIGN_ARCHIVE_OP, CAMPAIGN_CREATE_OP, isArchivable } from './campaign-controls.js';
import type { CsvColumn } from './csv.js';
import type { GrowthCampaignWire } from '@hushbox/shared';

/**
 * The link a campaign tag produces, which is the thing an operator shares.
 * The site address is registry-defined in every mode, so a missing or
 * malformed value is a build misconfiguration and is parsed rather than
 * defaulted.
 */
function campaignLink(tag: string): string {
  const site = z.url().parse(import.meta.env['VITE_WEB_URL']);
  return `${site}/welcome?c=${tag}`;
}

/** What the table holds, as its caption and as the name of the box it scrolls in. */
const TABLE_CAPTION = 'Campaign tags, active and archived';

/** What this table's named columns are called, on screen and in the exported file. */
const HEADERS = { tag: 'Tag', label: 'Label', status: 'Status', link: 'Link' } as const;

/**
 * This list as a file: every campaign the read returned, with the link an
 * operator shares rather than the tag alone.
 */
export function campaignColumns(): readonly CsvColumn<GrowthCampaignWire>[] {
  return [
    { header: HEADERS.tag, value: (row) => row.tag },
    { header: HEADERS.label, value: (row) => row.label },
    { header: HEADERS.status, value: (row) => row.status },
    { header: HEADERS.link, value: (row) => campaignLink(row.tag) },
  ];
}

/**
 * The campaign list, with the create and archive controls drawn only when the
 * operations catalogue this screen was served names them. Both run through the
 * shared operation modal, so a campaign change gets the same preview, audit row
 * and undo as every other admin mutation.
 */
export function CampaignsPanel({
  rows,
  canManage,
}: Readonly<{
  readonly rows: readonly GrowthCampaignWire[];
  readonly canManage: boolean;
}>): React.JSX.Element {
  const runOp = useRunOp();

  return (
    <div>
      {canManage && (
        <div className="mb-2 flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              runOp({ opName: CAMPAIGN_CREATE_OP });
            }}
          >
            Create campaign
          </Button>
        </div>
      )}
      <ScrollRegion label={TABLE_CAPTION} className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{TABLE_CAPTION}</caption>
          <thead>
            <tr className="text-muted-foreground text-xs uppercase">
              <th scope="col" className="py-1 pr-2 font-semibold">
                {HEADERS.tag}
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                {HEADERS.label}
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                {HEADERS.status}
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                {HEADERS.link}
              </th>
              {canManage && <th scope="col" className="py-1 pl-2" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.tag} className="border-border border-b">
                <td className="py-1 pr-2 font-mono text-xs">{row.tag}</td>
                <td className="py-1 pr-2">{row.label}</td>
                <td className="py-1 pr-2">{row.status}</td>
                <td className="py-1 pr-2">
                  <CopyableId value={campaignLink(row.tag)} label={`link for ${row.tag}`} />
                </td>
                {canManage && (
                  <td className="py-1 pl-2 text-right">
                    {isArchivable(row) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          runOp({ opName: CAMPAIGN_ARCHIVE_OP, initialValues: { tag: row.tag } });
                        }}
                      >
                        Archive {row.tag}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}
