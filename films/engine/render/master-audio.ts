/**
 * Where a film's master WAV sits inside the package's public directory, as the
 * POSIX path `staticFile` takes: the `score` verb writes it there, and a
 * composition's preview `<Audio>` reads it back through `staticFile`.
 */
export function masterAudioPath(filmId: string): string {
  return `${filmId}/master.wav`;
}
