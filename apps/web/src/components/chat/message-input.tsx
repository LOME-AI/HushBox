import * as React from 'react';
import { Button, Textarea } from '@lome-chat/ui';
import { Send } from 'lucide-react';

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, disabled }: MessageInputProps): React.JSX.Element {
  const [value, setValue] = React.useState('');

  const handleSend = (): void => {
    const trimmed = value.trim();
    if (trimmed) {
      onSend(trimmed);
      setValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isEmpty = value.trim().length === 0;

  return (
    <div className="flex gap-2 p-4">
      <Textarea
        placeholder="Type a message..."
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className="min-h-[44px] flex-1 resize-none"
        rows={1}
      />
      <Button
        aria-label="Send message"
        onClick={handleSend}
        disabled={(disabled ?? false) || isEmpty}
        size="icon"
        className="h-11 w-11 shrink-0"
      >
        <Send className="h-5 w-5" />
      </Button>
    </div>
  );
}
