import type { WidgetShape } from '@fixture/shared/widget-shape';

export interface WidgetShapePort {
  shape(id: string): WidgetShape;
}
