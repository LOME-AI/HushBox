/**
 * Maps a MIME type to a reasonable file extension. Covers every format the
 * HushBox AI SDK emits today (PNG/JPEG/WEBP/MP4/MP3/WAV); unknown types fall
 * back to `bin` so downloads still work. The actual byte sniffing happens
 * server-side via the `file-type` package at generation time — this client
 * helper only exists to reverse the stored `mimeType` for a friendly filename.
 */
export function getExtensionFromMime(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'bin';
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
