import { createApp } from './app.js';
import { scheduledHandler } from './scheduled.js';

export { ConversationRoom } from '@hushbox/realtime';

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
};
