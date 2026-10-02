import type { WidgetLabel } from '@fixture/shared/widget';

export interface WidgetLabelPort {
  label(id: string): WidgetLabel;
}
