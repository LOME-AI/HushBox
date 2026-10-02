import { TOTAL_FEE_RATE, formatFeePercent } from '@hushbox/shared';
import {
  Eraser,
  Eye,
  Fingerprint,
  HatGlasses,
  KeyRound,
  Lock,
  Sparkles,
  type IconComponent,
} from '@hushbox/ui/icons';

export interface WordBlockCopy {
  readonly icon: IconComponent;
  readonly title: string;
  readonly text: string;
}

export const VALUE_BLOCKS: readonly WordBlockCopy[] = [
  {
    icon: Lock,
    title: 'Privacy',
    text: "Your conversations stay yours. We work exclusively with AI providers that guarantee zero data retention. Privacy isn't a feature. It's the foundation.",
  },
  {
    icon: Sparkles,
    title: 'Innovation',
    text: "You shouldn't have to choose between powerful and principled. We build everything you need, as fast as you need it. We ship fast and we don't stop.",
  },
  {
    icon: Eye,
    title: 'Transparency',
    text: `Every single line of code is published. Our pricing is public. A ${formatFeePercent(TOTAL_FEE_RATE)} fee. No subscriptions. You only pay for what you use. You don't have to trust our promises. You can read our code.`,
  },
];

export const TRUST_BLOCKS: readonly WordBlockCopy[] = [
  {
    icon: KeyRound,
    title: 'Your Messages, Your Key',
    text: 'Only your devices can read your conversations. Without your password, your data is inaccessible. Even to us.',
  },
  {
    icon: Fingerprint,
    title: 'Zero-Knowledge Password',
    text: "Your password never leaves your device. We use OPAQUE, the state of the art in password security. We couldn't see it if we tried.",
  },
  {
    icon: Eraser,
    title: 'Zero Data Retention',
    text: 'We work exclusively with AI providers that guarantee zero data retention. Your messages are processed and forgotten. Never stored. Never trained on.',
  },
  {
    icon: HatGlasses,
    title: 'Anonymous',
    text: "AI providers see HushBox. They don't see you. Your identity is never attached to your conversations.",
  },
];
