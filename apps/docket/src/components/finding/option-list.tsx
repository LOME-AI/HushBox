import { Button } from '@hushbox/ui';
import { Badge } from '@hushbox/ui/marks';
import { TEST_IDS } from '@/test-ids';
import { FindingHtml } from './finding-html';
import { PromptForm } from './prompt-form';
import type { RenderedOption } from '@hushbox/docket';
import type { JSX } from 'react';

export interface OptionListProps {
  readonly options: readonly RenderedOption[];
  readonly needsOptions: boolean;
  /** The option a decision already settled on, if the finding has been decided. */
  readonly chosen?: string | null;
  /** The other way a finding is decided, and the one no ruling records. */
  readonly denied?: boolean;
  /** The option whose note field the keyboard sent the reader to, and which request sent them. */
  readonly noteFocus: { readonly option: string; readonly at: number } | null;
  readonly onChoose: (optionId: string) => void;
  readonly onNote: (optionId: string, note: string) => void;
  /** Which option is carrying words nobody has sent yet. */
  readonly onDrafting: (optionId: string, drafting: boolean) => void;
}

/**
 * The option a decision settled on has to read differently from one nobody has
 * taken, and differently again from the one the audit recommends: a chosen
 * option rendered in the variant an untaken one uses is what made a ruled
 * finding indistinguishable from an open one.
 */
function chosenVariant(
  option: RenderedOption,
  chosen: string | null
): 'secondary' | 'default' | 'outline' {
  if (option.id === chosen) return 'secondary';
  return option.recommended ? 'default' : 'outline';
}

/**
 * What there is to choose from. Most of a migrated audit carries nothing here,
 * so the empty case is an explicit statement rather than a blank space: the
 * reader still has the card's own decisions below it.
 */
export function OptionList({
  options,
  needsOptions,
  chosen = null,
  denied = false,
  noteFocus,
  onChoose,
  onNote,
  onDrafting,
}: OptionListProps): JSX.Element {
  if (options.length === 0) {
    // A decided finding is not waiting for options: the decision was taken
    // without them, and promising them here contradicts the summary above.
    // Denial is the half of "decided" no ruling records, so it is read
    // alongside the ruling rather than inferred from it.
    const awaiting = needsOptions && chosen === null && !denied;
    return (
      <div className="border-border text-muted-foreground rounded-md border border-dashed p-3 text-sm">
        <p className="text-foreground font-medium">No options were minted for this finding</p>
        {/* Only the ruling is named. Denial and questions are withheld on some
            states and each already states its own availability where it sits,
            so naming them from here offers controls the card may not carry. */}
        <p className="mt-1">
          {awaiting
            ? 'It is queued for option minting. Rule it in your own words.'
            : 'Rule it in your own words.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {options.map((option, index) => (
        <div key={option.id} className="border-border flex flex-col gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={chosenVariant(option, chosen)}
              {...(option.recommended ? { 'data-recommended': 'true' } : {})}
              {...(option.id === chosen ? { 'data-chosen': 'true' } : {})}
              data-testid={TEST_IDS.optionChoice}
              onClick={() => {
                onChoose(option.id);
              }}
            >
              <span className="font-mono">{index + 1}</span>
              <span>
                {option.id}: {option.label}
              </span>
            </Button>
            {option.id === chosen && <Badge tone="neutral">Chosen</Badge>}
            {option.recommended && <Badge tone="neutral">Recommended</Badge>}
            {/* Its own badge rather than a second reading of the recommendation:
                an option can be both the one to take and the one that owes the
                finding a session, and the two say different things. */}
            {option.dedicated && <Badge tone="secondary">Dedicated</Badge>}
          </div>
          {option.meta !== null && (
            <FindingHtml html={option.meta} className="text-muted-foreground text-sm" />
          )}
          <FindingHtml html={option.html} />
          <div data-testid={TEST_IDS.optionNote}>
            <PromptForm
              title={`Note on ${option.id}`}
              placeholder="how this ruling should be carried out"
              submitLabel="Rule with note"
              focus={noteFocus?.option === option.id ? noteFocus.at : null}
              onSubmit={(text) => {
                onNote(option.id, text);
              }}
              onDrafting={(drafting) => {
                onDrafting(option.id, drafting);
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
