// Ticket 338 (owner 11-09): "Ask before closing a running session tab" in General; off by default, unlike final.html's drawing.
import { defineSetting } from '../settings/useFeatureSetting';

export const ASK_CLOSE_RUNNING = defineSetting<boolean>('tabs.ask_close_running', false, (v) => (typeof v === 'boolean' ? v : undefined));
