/**
 * Mime fragment → extension, first match wins, so the order is load-bearing.
 */
const EXTENSION_BY_MIME_FRAGMENT: readonly (readonly [fragment: string, extension: string])[] = [
  ['png', 'png'],
  ['jpeg', 'jpg'],
  ['jpg', 'jpg'],
  ['webp', 'webp'],
  ['mp4', 'mp4'],
  ['webm', 'webm'],
  // `video/mpeg` is an MPEG video, not MP3 audio — only the audio MPEG profile
  // is the MP3 file format, so the video case is matched before the audio one.
  ['video/mpeg', 'mpeg'],
  ['mpeg', 'mp3'],
  ['mp3', 'mp3'],
  ['wav', 'wav'],
];

/**
 * Maps a MIME type to a reasonable file extension. Covers every format the
 * HushBox AI SDK emits today (PNG/JPEG/WEBP/MP4/WEBM/MP3/WAV); unknown types
 * fall back to `bin` so downloads still work. The actual byte sniffing happens
 * server-side via the `file-type` package at generation time — this client
 * helper only exists to reverse the stored `mimeType` for a friendly filename.
 */
export function getExtensionFromMime(mimeType: string): string {
  const matched = EXTENSION_BY_MIME_FRAGMENT.find(([fragment]) => mimeType.includes(fragment));
  return matched === undefined ? 'bin' : matched[1];
}

/**
 * Builds a user-friendly filename like `hushbox-image-20260417-103045.png`.
 * Uses local time — the stamp is sampled when the caller builds the
 * download, which is close enough to "when the user saves it" for UX.
 */
export function buildDownloadFilename(
  contentType: 'image' | 'audio' | 'video',
  mimeType: string
): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());
  return `hushbox-${contentType}-${stamp}.${getExtensionFromMime(mimeType)}`;
}
