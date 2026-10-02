import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { Button, ButtonRow } from '@hushbox/ui/button';
import { TextField } from '@hushbox/ui/field';
import { ModelNameplate } from '@/components/chat/message/model-nameplate';

/** The link draws as a reply's link does, and goes nowhere: the preview only shows a setting's effect. */
function stayOnPage(event: React.MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
}

/**
 * A sample reply, field and button pair drawn with the app's own pieces, so every accessibility
 * setting shows its effect here without leaving the page. Every control takes focus and does
 * nothing. Below 768 only the reply shows, and the preview sticks on its own while the link row
 * above it scrolls away.
 */
export function AccessibilityPreview(): React.JSX.Element {
  const labelId = React.useId();
  return (
    <section
      aria-labelledby={labelId}
      data-testid={TEST_IDS.accessibilityPreview}
      className="bg-background-paper border-border max-md:z-sticky flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border px-4 py-3.5 max-md:sticky max-md:top-0 max-md:rounded-none max-md:border-x-0 max-md:border-t-0 md:mt-2.5"
    >
      <div className="flex min-w-0 flex-[1_1_22rem] flex-col gap-1.5">
        <span id={labelId} className="text-caption text-muted-foreground font-semibold">
          Preview
        </span>
        <ModelNameplate modelName="Claude Sonnet 4.5" provider="Anthropic" swatch={1} />
        {/* Below 768 the clamp can cut the link off while it stays in the tab order, so keyboard focus on it lifts the clamp. */}
        <p
          data-reading=""
          className="text-body text-foreground max-md:line-clamp-3 max-md:has-[:focus-visible]:line-clamp-none"
        >
          Sourdough at 75% hydration means 750 g of water for every kilogram of flour. Start at 70%
          if the dough feels hard to shape, and read the{' '}
          <a
            href="#hydration-guide"
            onClick={stayOnPage}
            className="text-brand-red font-medium underline"
          >
            hydration guide
          </a>{' '}
          for the full method.
        </p>
      </div>
      <div
        data-preview-form=""
        className="flex min-w-0 flex-[1_1_15rem] flex-col gap-2 max-md:hidden"
      >
        <TextField label="Loaf weight" value="900 g" readOnly />
        <ButtonRow>
          <Button type="button" variant="outline">
            Cancel
          </Button>
          <Button type="button">Save recipe</Button>
        </ButtonRow>
      </div>
    </section>
  );
}
