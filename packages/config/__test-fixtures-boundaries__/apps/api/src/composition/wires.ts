import type { WidgetPort } from '../slices/delta/index.js';
import type { WidgetPort as DoorWidgetPort } from '../slices/delta/public/widget-door.js';
import { describeWidget } from '../lib/context/imports-workspace-package.js';
import { pipeline } from '../middleware/pipeline.js';

export type Wired = { port: WidgetPort; door: DoorWidgetPort };
export const wired = `${describeWidget({ id: pipeline })}`;
