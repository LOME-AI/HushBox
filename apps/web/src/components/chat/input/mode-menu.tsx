import * as React from 'react';
import { Menu, MenuRadioGroup, MenuRadioItem } from '@hushbox/ui/menu';
import { Icon, Image, Lock, Mic, Plus, Type, Video, type IconComponent } from '@hushbox/ui/icons';
import { TEST_IDS } from '@hushbox/shared';
import { Chip } from '@/components/shared/chip';
import type { usePayerPremiumAccess } from '@/hooks/models/use-payer-premium-access';
import type { ChatModality } from '@hushbox/shared';

type PremiumAccess = ReturnType<typeof usePayerPremiumAccess>;

const MENU_LABEL = 'Change mode';

/**
 * The two things a premium-gated mode says when its payer may not enter it.
 * They travel as one object because presence is the gate: a mode every payer
 * may enter carries none, and one that carries them cannot acquire only half a
 * vocabulary.
 */
interface PremiumGateLabels {
  /** The payer's tier settles it: they reach no model of this mode. */
  readonly blocked: string;
  /** No answer is in hand, and one may never come (an exhausted funding read). */
  readonly unknown: string;
}

interface ModeEntry {
  readonly modality: ChatModality;
  readonly title: string;
  /** The remedy for a visitor who has not signed up. */
  readonly visitorReason: string;
  /**
   * Present on exactly the modes only a premium-reaching payer may enter. Every
   * model of these is premium, so premium reach is the whole entry condition;
   * text carries none because no tier is shut out of it.
   */
  readonly premiumGate?: PremiumGateLabels;
  readonly icon: IconComponent;
}

const MODE_ENTRIES: readonly ModeEntry[] = [
  {
    modality: 'text',
    title: 'Text',
    visitorReason: 'Sign up to unlock text generation',
    icon: Type,
  },
  {
    modality: 'image',
    title: 'Image',
    visitorReason: 'Sign up to unlock image generation',
    premiumGate: {
      blocked: 'Add credit to unlock image generation',
      unknown: 'Image generation unavailable while your balance is unknown',
    },
    icon: Image,
  },
  {
    modality: 'video',
    title: 'Video',
    visitorReason: 'Sign up to unlock video generation',
    premiumGate: {
      blocked: 'Add credit to unlock video generation',
      unknown: 'Video generation unavailable while your balance is unknown',
    },
    icon: Video,
  },
  {
    modality: 'audio',
    title: 'Audio',
    visitorReason: 'Sign up to unlock audio generation',
    premiumGate: {
      blocked: 'Add credit to unlock audio generation',
      unknown: 'Audio generation unavailable while your balance is unknown',
    },
    icon: Mic,
  },
];

/**
 * Why one mode may not be entered, or `undefined` when it may.
 *
 * Absent premium reach is a closed door, not a pending one: offering the item
 * first and locking it when the answer lands admits the choice it exists to
 * refuse, and behind that choice sits a mode with no model to select.
 *
 * The signed-out leg is first because it is the one certainty here: a visitor
 * with no account is told to make one, and every arm below it belongs to
 * someone who already has one and must never be told to sign up again. The
 * mode the composer is already in is never locked, since choosing it enters
 * nothing.
 */
function lockReason(
  entry: ModeEntry,
  activeModality: ChatModality,
  isAuthenticated: boolean,
  premiumAccess: PremiumAccess
): string | undefined {
  if (entry.modality === activeModality) return undefined;
  if (!isAuthenticated) return entry.visitorReason;
  const gate = entry.premiumGate;
  if (gate === undefined) return undefined;
  if (premiumAccess.status !== 'known') return gate.unknown;
  return premiumAccess.canAccessPremium ? undefined : gate.blocked;
}

interface ModeMenuProps {
  readonly activeModality: ChatModality;
  readonly onSelect: (modality: ChatModality) => void;
  /** A visitor sees every other mode locked, with the sign-up remedy. */
  readonly isAuthenticated: boolean;
  /** What the payer of this conversation can reach, or why that is not known. */
  readonly premiumAccess: PremiumAccess;
  /** Whether Audio is offered at all. */
  readonly audioEnabled: boolean;
  /** Rows placed in the menu after the modes. */
  readonly extraRows?: React.ReactNode;
  /** From 768px, the element the menu opens 0.5rem below, flush with its left edge. */
  readonly anchor?: React.RefObject<HTMLElement | null> | undefined;
  /** Given the "+", for a caller that returns focus to it. */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null> | undefined;
}

/**
 * The composer's mode control: the "+" that opens the modes as a radio menu, and,
 * outside text mode, the pressed chip naming the current mode. Pressing that chip
 * returns the composer to text; the chip then leaves, so focus goes to the "+".
 */
export function ModeMenu({
  activeModality,
  onSelect,
  isAuthenticated,
  premiumAccess,
  audioEnabled,
  extraRows,
  anchor,
  triggerRef: callerTriggerRef,
}: Readonly<ModeMenuProps>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const ownTriggerRef = React.useRef<HTMLButtonElement>(null);
  const triggerRef = callerTriggerRef ?? ownTriggerRef;
  const entries = MODE_ENTRIES.filter((entry) => entry.modality !== 'audio' || audioEnabled);
  const active = MODE_ENTRIES.find((entry) => entry.modality === activeModality);

  return (
    <>
      <Menu
        trigger={
          <Chip
            ref={triggerRef}
            icon={Plus}
            iconOnly
            label={MENU_LABEL}
            expanded={open}
            data-testid={TEST_IDS.modeMenuButton}
          />
        }
        title={MENU_LABEL}
        align="start"
        minWidth="12rem"
        {...(anchor !== undefined && { anchor: { element: anchor, offset: '0.5rem' } })}
        open={open}
        onOpenChange={setOpen}
      >
        <MenuRadioGroup<ChatModality> value={activeModality} onValueChange={onSelect}>
          {entries.map((entry) => {
            const reason = lockReason(entry, activeModality, isAuthenticated, premiumAccess);
            return (
              <MenuRadioItem<ChatModality>
                key={entry.modality}
                value={entry.modality}
                icon={entry.icon}
                title={entry.title}
                {...(reason !== undefined && {
                  disabled: true,
                  disabledReason: reason,
                  mark: <Icon icon={Lock} size="sm" />,
                })}
              />
            );
          })}
        </MenuRadioGroup>
        {extraRows}
      </Menu>
      {active !== undefined && activeModality !== 'text' && (
        <Chip
          icon={active.icon}
          label={active.title}
          aria-label={`Mode: ${active.modality}`}
          pressed
          onClick={() => {
            onSelect('text');
            triggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
