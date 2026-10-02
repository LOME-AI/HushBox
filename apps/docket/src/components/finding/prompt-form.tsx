import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import { ConsoleTextarea } from '../console-fields';
import type { JSX, ReactNode } from 'react';

/**
 * Every draft the console is holding. Stepping to the next finding, following a
 * related chip and landing on a write's outcome all unmount the box, and none of
 * them is a decision to throw the words away, so the words outlive the box and
 * come back when the reader returns to the finding they were written on. A slot
 * per key rather than one slot for the store: two findings can each be carrying
 * an unsent draft, and a single slot would have the second silently destroy the
 * first.
 *
 * The audit is part of the key for the reason the finding is. Prefixes are
 * chosen per audit, so two of them can each carry a finding called AC-1, and a
 * key naming the finding alone would hand one audit's words to the other. The
 * audit a reader leaves keeps its drafts rather than losing them: they are
 * still unsent, and still about the findings they were written on.
 */
const kept = new Map<string, string>();

/**
 * A console that names no audit is one that cannot be moved off the audit it is
 * on, so every draft in it belongs to the same place and one slot holds them.
 * No real audit is called this: an empty `audit` in the address bar reads as
 * naming none.
 */
const UNNAMED_AUDIT = '';

const DraftAudit = createContext<string>(UNNAMED_AUDIT);
const DraftFinding = createContext<string | null>(null);

/**
 * Which audit the boxes inside it are writing about. Separate from the audit a
 * request is addressed to, and deliberately so: this asks who owns the words,
 * which every mount of a box can answer, while the address is a question only a
 * surface that writes, briefs or peeks has to be able to answer at all.
 */
export function PromptDraftAudit({
  audit,
  children,
}: Readonly<{ audit: string; children: ReactNode }>): JSX.Element {
  return <DraftAudit value={audit}>{children}</DraftAudit>;
}

/**
 * Which finding the boxes inside it are writing about. Without one a box keeps
 * no draft at all, because a draft with no owner could only be restored onto
 * the wrong finding.
 */
export function PromptDraftScope({
  finding,
  children,
}: Readonly<{ finding: string | null; children: ReactNode }>): JSX.Element {
  return <DraftFinding value={finding}>{children}</DraftFinding>;
}

export interface PromptFormProps {
  readonly title: string;
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly onSubmit: (text: string) => void;
  /** The way through without text, where one exists: deny needs no reason. */
  readonly secondary?: { readonly label: string; readonly onClick: () => void };
  /**
   * The request that sent the caret here, rising with every one the console
   * makes. A number rather than a flag because a shortcut aimed at a box the
   * reader has already left has to move the caret again, and a flag that is
   * already set says nothing has changed.
   */
  readonly focus?: number | null;
  /**
   * Words written and not yet sent. The console's shortcuts are registered on
   * the window, so a click that takes the caret out of the box without ending
   * the edit — a citation, anywhere in the prose — would otherwise leave a
   * digit live over words still being written.
   */
  readonly onDrafting?: (drafting: boolean) => void;
}

/**
 * The one text box in the ruling loop, wearing four hats: a denial reason, a
 * free-text ruling, a question, and a note on a chosen option. They differ only
 * in copy, and a second implementation would drift on the draft handling.
 *
 * It is always on screen. A field behind a control is a field a reader has to
 * know is there, and every one of these is part of taking a decision rather
 * than an aside to it. It opens at a single line and takes the height it needs
 * as it is written into, so the ones nobody is using cost a line each.
 *
 * Escape is handled here rather than as a shortcut because `useHotkeys` never
 * fires a key without Ctrl or Meta, such as Escape, while a text box has the caret.
 */
export function PromptForm({
  title,
  placeholder,
  submitLabel,
  onSubmit,
  secondary,
  focus,
  onDrafting,
}: PromptFormProps): JSX.Element {
  const audit = useContext(DraftAudit);
  const finding = useContext(DraftFinding);
  const key = finding === null ? null : `${audit}|${finding}|${title}`;
  const [restored] = useState(() => (key === null ? '' : (kept.get(key) ?? '')));
  const [text, setText] = useState(restored);
  const box = useRef<HTMLTextAreaElement>(null);
  const trimmed = text.trim();
  const drafting = trimmed !== '';

  // The cleanup runs after the last render, so it reads the words through a ref
  // rather than the closure it was created in.
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);

  useEffect(
    () => () => {
      if (key === null) return;
      // An emptied box is the reader saying they are finished with the words,
      // however they emptied it: sent, cleared, or escaped out of.
      if (latest.current.trim() === '') {
        kept.delete(key);
        return;
      }
      kept.set(key, latest.current);
    },
    [key]
  );

  // Reported through a ref so a caller that rebuilds its handler every render
  // does not turn the report into a re-render loop.
  const report = useRef(onDrafting);
  useEffect(() => {
    report.current = onDrafting;
  }, [onDrafting]);
  // The retraction is the cleanup rather than a separate unmount effect, so it
  // covers the case a card cannot: a box is withheld the moment the decision it
  // takes has been taken, and it can go while it still holds words. Whatever
  // the report raised — the console's whole keyboard hangs off it — has to come
  // back off with the box, because nothing on screen is holding those words any
  // more and nothing on screen can give the keyboard back.
  useEffect(() => {
    report.current?.(drafting);
    return () => {
      report.current?.(false);
    };
  }, [drafting]);

  useEffect(() => {
    if (focus !== null && focus !== undefined) box.current?.focus();
  }, [focus]);

  return (
    <div className="border-border bg-muted/30 flex flex-col gap-2 rounded-md border p-3">
      <p className="text-muted-foreground text-sm font-semibold uppercase">{title}</p>
      {restored !== '' && text === restored && (
        <p className="text-muted-foreground text-sm">Restored from your unsent draft.</p>
      )}
      <ConsoleTextarea
        data-testid={TEST_IDS.promptInput}
        ref={box}
        rows={1}
        className="min-h-0"
        aria-label={title}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setText('');
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!drafting}
          onClick={() => {
            setText('');
            onSubmit(trimmed);
          }}
        >
          {submitLabel}
        </Button>
        <Button
          variant="outline"
          disabled={!drafting}
          onClick={() => {
            setText('');
          }}
        >
          Clear
        </Button>
        {secondary !== undefined && (
          <Button variant="ghost" onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        )}
      </div>
    </div>
  );
}
