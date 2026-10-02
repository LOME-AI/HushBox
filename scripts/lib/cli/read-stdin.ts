/**
 * The bytes a hook is fed on stdin, as text. Git's hook protocol arrives this
 * way, and every hook entry point reads it identically — the concatenation is
 * what makes a multi-byte character split across two chunks survive.
 */
export async function readStdin(
  stream: AsyncIterable<Uint8Array> = process.stdin
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
