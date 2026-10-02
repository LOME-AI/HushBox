import * as React from 'react';
import { StreamdownContext } from 'streamdown';
import { useCopyToClipboard } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { Check, Copy, Download, Icon } from '@hushbox/ui/icons';
import { getFileExtension } from '@/lib/chat/document-parser';
import { downloadTextFile } from '@/lib/download-text-file';

interface CodeBlockHeaderProps {
  language: string;
  code: string;
}

const TOOL_CLASS = 'text-muted-foreground hover:text-foreground h-7 px-2 text-xs';

function downloadName(language: string): string {
  return `file.${language === '' ? 'txt' : getFileExtension(language)}`;
}

/**
 * A code block's header: its language, and Download and Copy for the block's code.
 * Both controls wait while the message streams, as the block's code is not final.
 */
export function CodeBlockHeader({
  language,
  code,
}: Readonly<CodeBlockHeaderProps>): React.JSX.Element {
  const { isAnimating } = React.useContext(StreamdownContext);
  const { copy, copied } = useCopyToClipboard();

  return (
    <div className="border-border bg-muted flex min-h-9 flex-wrap items-center justify-between gap-x-2 border-b py-1 ps-3.5 pe-1 font-sans text-xs">
      <span className="text-muted-foreground min-w-0 wrap-anywhere lowercase">{language}</span>
      <span className="ms-auto flex flex-wrap items-center justify-end gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className={TOOL_CLASS}
          disabled={isAnimating}
          onClick={() => {
            downloadTextFile(downloadName(language), code);
          }}
        >
          <Icon icon={Download} />
          Download
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={TOOL_CLASS}
          disabled={isAnimating}
          onClick={() => {
            void copy(code);
          }}
        >
          <Icon icon={copied ? Check : Copy} />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </span>
      <span role="status" className="sr-only">
        {copied ? 'Code copied' : ''}
      </span>
    </div>
  );
}
