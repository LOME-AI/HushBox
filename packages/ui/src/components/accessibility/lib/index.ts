export * from './colorblind-matrices';
export { SvgColorblindDefs } from './svg-colorblind-defs';
export { applySettings } from './apply-settings';
export { A11Y_INIT_SCRIPT } from './init-script';
export { activateFont, _resetFontLoaderForTesting } from './font-loader';
export { installMutePauser } from './mute';
export { installMediaPauser } from './media-pauser';
export { MotionProvider } from './motion-provider';
export {
  ACCESSIBILITY_PROFILES,
  getProfile,
  type AccessibilityProfile,
  type ProfileId,
} from './profiles';
export {
  getTtsService,
  _resetTtsServiceForTesting,
  TTS_VOICES,
  type TtsService,
  type TtsVoice,
  type TtsVoiceMeta,
} from './tts-engine';
export { SentenceChunker } from './sentence-chunker';
export {
  createTtsStreamFeeder,
  type TtsStreamFeeder,
  type CreateTtsStreamFeederOptions,
} from './tts-stream-feeder';
