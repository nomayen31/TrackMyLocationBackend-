/**
 * push — Web Push delivery, so an incoming call can ring even when the tab is
 * closed.
 *
 * Uses the official `web-push` library with VAPID keys kept on the server.
 * Subscriptions are stored per user in `push_subscriptions`; expired endpoints
 * (404/410) are pruned automatically.
 *
 * Requires HTTPS in the browser (Push API is a secure-context feature).
 */
const webpush = require('web-push');
const pool = require('../config/db');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@triptracker.local';

const configured = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

/** Store (or refresh) a browser subscription for a user. */
async function saveSubscription(userId, subscription, userAgent) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    const err = new Error('Invalid push subscription');
    err.code = 'INVALID_SUBSCRIPTION';
    throw err;
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh  = EXCLUDED.p256dh,
           auth    = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent`,
    [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, String(userAgent || '').slice(0, 300)]
  );
  return true;
}

async function removeSubscription(userId, endpoint) {
  if (!endpoint) return false;
  const r = await pool.query(
    'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
    [endpoint, userId]
  );
  return r.rowCount > 0;
}

/** How many devices this user has subscribed. */
async function countForUser(userId) {
  const r = await pool.query('SELECT count(*)::int AS c FROM push_subscriptions WHERE user_id = $1', [userId]);
  return r.rows[0].c;
}

/**
 * Send a payload to every subscribed device of one user.
 * Returns { sent, pruned, skipped? }.
 */
async function sendToUser(userId, payload) {
  if (!configured) return { sent: 0, pruned: 0, skipped: 'not-configured' };

  const rows = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  if (rows.rows.length === 0) return { sent: 0, pruned: 0, skipped: 'no-subscriptions' };

  let sent = 0;
  const stale = [];

  await Promise.all(
    rows.rows.map(async (row) => {
      const subscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 });
        sent += 1;
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) stale.push(row.endpoint);
        else console.error('Push send failed:', err?.statusCode || err?.message);
      }
    })
  );

  if (stale.length > 0) {
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1)', [stale]);
  }
  return { sent, pruned: stale.length };
}

module.exports = {
  configured,
  publicKey: PUBLIC_KEY,
  saveSubscription,
  removeSubscription,
  countForUser,
  sendToUser,
};
