/** The URL scheme the native apps register, so a link in the system browser opens the app. */
export const APP_URL_SCHEME = 'hushbox';

/**
 * Where the billing portal sends a user back to the app after a purchase. It carries no
 * token: the portal's one-time token belongs to the browser session and never travels back.
 * A custom scheme rather than an https link, because an https link stays in the browser.
 */
export const APP_RETURN_TO_BILLING_URL = `${APP_URL_SCHEME}://billing`;

/**
 * The app button that mints a billing portal link. The portal's expired state and the
 * emails name it, so the name they give is the button's own.
 */
export const MANAGE_BALANCE_ONLINE_LABEL = 'Manage Balance Online';
