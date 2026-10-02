/** Saves `text` as a plain-text file named `filename` through the browser's download. */
export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // The browser claims the file while it is still handling the click, so the release waits
  // for the next task rather than racing it.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
