import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { downloadTextFile } from './download-text-file';

const FILE_URL = 'blob:saved-text';

interface Captured {
  blob: Blob | undefined;
  anchor: HTMLAnchorElement | undefined;
}

describe('downloadTextFile', () => {
  const captured: Captured = { blob: undefined, anchor: undefined };
  const revokeObjectURL = vi.fn<(url: string) => void>();
  const originalCreate = URL.createObjectURL.bind(URL);
  const originalRevoke = URL.revokeObjectURL.bind(URL);

  beforeEach(() => {
    captured.blob = undefined;
    captured.anchor = undefined;
    revokeObjectURL.mockReset();
    URL.createObjectURL = (object: Blob | MediaSource): string => {
      if (object instanceof Blob) captured.blob = object;
      return FILE_URL;
    };
    URL.revokeObjectURL = revokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      captured.anchor = this;
    });
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it('saves the file under the given name', () => {
    downloadTextFile('notes.txt', 'hello');

    expect(captured.anchor?.download).toBe('notes.txt');
  });

  it('points the saving link at the file it made', () => {
    downloadTextFile('notes.txt', 'hello');

    expect(captured.anchor?.href).toBe(FILE_URL);
  });

  it('saves exactly the given text', async () => {
    const text = 'apple brave candy\ndelta';

    downloadTextFile('notes.txt', text);

    expect(await captured.blob?.text()).toBe(text);
  });

  it('saves the text as plain text', () => {
    downloadTextFile('notes.txt', 'hello');

    expect(captured.blob?.type).toBe('text/plain');
  });

  it('keeps the file URL until the click has been handled', () => {
    downloadTextFile('notes.txt', 'hello');

    expect(captured.anchor).toBeDefined();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('releases the file URL once the click has been handled', async () => {
    downloadTextFile('notes.txt', 'hello');

    await vi.waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith(FILE_URL);
    });
  });
});
