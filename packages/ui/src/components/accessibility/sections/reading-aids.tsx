import * as React from 'react';

import { SettingCard } from '../controls/setting-card';
import { useA11yStore } from '../store';
import { ON_OFF_OPTIONS } from './_constants';

export function ReadingAidsSection(): React.JSX.Element {
  const magnifier = useA11yStore((s) => s.magnifier);
  const readingGuide = useA11yStore((s) => s.readingGuide);
  const pageStructure = useA11yStore((s) => s.pageStructure);
  const update = useA11yStore((s) => s.update);

  return (
    <section aria-labelledby="a11y-reading-aids-heading" className="flex flex-col gap-3">
      <h2 id="a11y-reading-aids-heading" className="text-lg font-semibold">
        Reading helpers
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <SettingCard
          title="Magnifier lens"
          options={ON_OFF_OPTIONS}
          value={magnifier ? 'on' : 'off'}
          onChange={(v) => {
            update({ magnifier: v === 'on' });
          }}
        />
        <SettingCard
          title="Reading band"
          options={ON_OFF_OPTIONS}
          value={readingGuide ? 'on' : 'off'}
          onChange={(v) => {
            update({ readingGuide: v === 'on' });
          }}
        />
        <SettingCard
          title="Page outline"
          options={ON_OFF_OPTIONS}
          value={pageStructure ? 'on' : 'off'}
          onChange={(v) => {
            update({ pageStructure: v === 'on' });
          }}
        />
      </div>
    </section>
  );
}
