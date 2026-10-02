import { CommandPalette, EmptyState } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import { paletteSections } from './logic/palette-sections';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface FindingPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly findings: readonly FindingJson[];
  readonly onJump: (id: string) => void;
}

/**
 * Reaching any finding by name from anywhere in the audit. A related id is one
 * hop; this is the way to a finding the reader only half remembers.
 */
export function FindingPalette({
  open,
  onClose,
  findings,
  onJump,
}: FindingPaletteProps): JSX.Element {
  return (
    <CommandPalette
      open={open}
      onClose={onClose}
      sections={(query) => paletteSections(findings, query)}
      onRun={(item) => {
        onJump(item.id);
      }}
      appearance="plain"
      empty={
        <EmptyState
          title="No finding matches that search"
          description="Try part of a finding id, or a word from its title."
        />
      }
      title="Jump to a finding"
      description="Type part of a finding id or title, then press Enter."
      placeholder="Jump to a finding"
      testId={TEST_IDS.findingPalette}
      inputTestId={TEST_IDS.paletteInput}
      optionTestId={TEST_IDS.paletteOption}
    />
  );
}
