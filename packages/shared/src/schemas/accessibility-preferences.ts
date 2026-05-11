import { z } from 'zod';

export const accessibilityPreferencesSchema = z.object({
  version: z.literal(1),

  // Visual
  contrast: z.enum(['normal', 'increased', 'high', 'low']).default('normal'),
  saturation: z.enum(['0', '50', '100', '150']).default('100'),
  invert: z.boolean().default(false),
  highlightLinks: z.boolean().default(false),
  colorblindSimulate: z
    .enum(['none', 'protan', 'deutan', 'tritan', 'achroma', 'achromatomaly'])
    .default('none'),

  // Typography
  fontSize: z.enum(['100', '125', '150', '175', '200']).default('100'),
  letterSpacing: z.enum(['0', '0.05', '0.12']).default('0'),
  lineHeight: z.enum(['1.0', '1.5', '2.0']).default('1.5'),
  paragraphSpacing: z.enum(['1', '2']).default('1'),
  forceLeftAlign: z.boolean().default(false),
  fontFamily: z.enum(['system', 'atkinson', 'open-dyslexic', 'lexend']).default('system'),

  // Reading aids
  magnifier: z.boolean().default(false),
  readingGuide: z.boolean().default(false),
  pageStructure: z.boolean().default(false),

  // Audio
  ttsEnabled: z.boolean().default(false),
  ttsVoice: z
    .enum(['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole'])
    .default('af_heart'),
  streamChatAloud: z.boolean().default(false),
  muteSounds: z.boolean().default(false),

  // Motion
  stopAnimations: z.boolean().default(false),

  // Pointer & focus
  cursorSize: z.enum(['normal', 'large', 'xlarge']).default('normal'),
  cursorColor: z.enum(['black', 'white']).default('black'),
  focusWidth: z.enum(['2', '4', '6']).default('2'),
  focusColor: z.enum(['yellow', 'magenta', 'cyan', 'lime', 'red']).default('yellow'),
  focusHalo: z.boolean().default(false),
});

export type AccessibilityPreferences = z.infer<typeof accessibilityPreferencesSchema>;
export const ACCESSIBILITY_PREFERENCES_DEFAULTS = accessibilityPreferencesSchema.parse({
  version: 1,
});
