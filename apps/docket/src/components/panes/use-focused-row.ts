import { useRef } from 'react';
import { useScrollIntoView } from '@/components/shell/hooks/use-scroll-into-view';
import type { SectionId } from '@/components/shell/logic/sections';
import type { RefObject } from 'react';

/**
 * Brings the focused row back on screen in a review pane, on the same anchor the
 * queue uses: the section is part of it because a link that resolves its section
 * after mount would otherwise never scroll, and the same finding in another
 * section is a different row in a different list.
 *
 * Shared by both review panes rather than written twice, because the anchor has
 * to be the shell's format to agree with it.
 */
export function useFocusedRow(
  section: SectionId,
  focus: string | null
): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement>(null);
  useScrollIntoView(ref, focus === null ? null : `${section}|${focus}`, 'nearest');
  return ref;
}
