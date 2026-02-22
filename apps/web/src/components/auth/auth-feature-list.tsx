import * as React from 'react';

export function AuthFeatureList(): React.JSX.Element {
  return (
    <div className="border-border mt-4 border-t pt-6">
      <ul className="text-muted-foreground space-y-3 text-sm">
        <li className="flex items-center gap-3">
          <span className="text-primary text-lg">{'\u2713'}</span>
          Privacy by design
        </li>
        <li className="flex items-center gap-3">
          <span className="text-primary text-lg">{'\u2713'}</span>
          Access GPT, Claude, Gemini & more
        </li>
        <li className="flex items-center gap-3">
          <span className="text-primary text-lg">{'\u2713'}</span>
          Your data is never sold or trained on
        </li>
      </ul>
    </div>
  );
}
