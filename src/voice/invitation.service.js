/**
 * invitation.service — invitation lifecycle for private voice rooms.
 *
 * Rules enforced here (never trusted from the client):
 *   - only a room owner may invite
 *   - the recipient must be a real user and not already a member
 *   - inviter and recipient must not be the same person
 *   - only one pending invitation per (room, recipient) — enforced by a partial
 *     unique index as well as this check
 *   - invitations expire; expired rows are marked and can no longer be accepted
 */
const pool = require('../config/db');

const DEFAULT_TTL_MINUTES = 30;
const MAX_TTL_MINUTES = 24 * 60;
const MESSAGE_MAX = 200;

const INVITE_COLUMNS = `
  i.id, i.room_id AS "roomId", i.sender_id AS "senderId", i.recipient_id AS "recipientId",
  i.status, i.created_at AS "createdAt", i.expires_at AS "expiresAt", i.responded_at AS "respondedAt"
`;

/** Mark any pending invitation whose time has run out. */
async function expireStale() {
  await pool.query(
    `UPDATE voice_invitations SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= NOW()`
  );
}

/** Open an invitation with its room/sender context for the UI. */
async function getInvitation(id) {
  const result = await pool.query(
    `SELECT ${INVITE_COLUMNS},
            r.name AS "roomName", r.is_private AS "roomPrivate", r.owner_id AS "roomOwnerId",
            s.name AS "senderName", COALESCE(s.image, s."avatarUrl") AS "senderAvatar"
     FROM voice_invitations i
     JOIN voice_rooms r ON r.id = i.room_id
     JOIN "user" s ON s.id = i.sender_id
     WHERE i.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Create an invitation. Caller must have already confirmed the sender owns the
 * room (see the socket/controller). Returns the shaped invitation or throws a
 * coded error.
 */
async function createInvitation({ roomId, senderId, recipientId, ttlMinutes = DEFAULT_TTL_MINUTES, message = '' }) {
  const cleanRecipient = String(recipientId || '').trim();
  if (!cleanRecipient) {
    const err = new Error('recipientId is required');
    err.code = 'INVALID_RECIPIENT';
    throw err;
  }
  if (cleanRecipient === senderId) {
    const err = new Error('You cannot invite yourself');
    err.code = 'SELF_INVITE';
    throw err;
  }

  const ttl = Math.min(MAX_TTL_MINUTES, Math.max(1, Math.round(Number(ttlMinutes) || DEFAULT_TTL_MINUTES)));

  // Recipient must exist (reuse the existing user table).
  const user = await pool.query('SELECT id, name FROM "user" WHERE id = $1', [cleanRecipient]);
  if (user.rows.length === 0) {
    const err = new Error('That user does not exist');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  // Already a member? Nothing to invite.
  const member = await pool.query(
    'SELECT 1 FROM voice_room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, cleanRecipient]
  );
  if (member.rows.length > 0) {
    const err = new Error('That user is already in the room');
    err.code = 'ALREADY_MEMBER';
    throw err;
  }

  const banned = await pool.query(
    'SELECT 1 FROM voice_room_bans WHERE room_id = $1 AND user_id = $2',
    [roomId, cleanRecipient]
  );
  if (banned.rows.length > 0) {
    const err = new Error('That user is banned from this room');
    err.code = 'BANNED';
    throw err;
  }

  // Clear out anything stale first, so a lapsed invite doesn't block a new one.
  await expireStale();

  const pending = await pool.query(
    `SELECT id FROM voice_invitations
     WHERE room_id = $1 AND recipient_id = $2 AND status = 'pending'`,
    [roomId, cleanRecipient]
  );
  if (pending.rows.length > 0) {
    const err = new Error('An invitation is already pending for that user');
    err.code = 'DUPLICATE_INVITE';
    throw err;
  }

  const inserted = await pool.query(
    `INSERT INTO voice_invitations (room_id, sender_id, recipient_id, expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(mins => $4::int))
     RETURNING id`,
    [roomId, senderId, cleanRecipient, ttl]
  );

  const invitation = await getInvitation(inserted.rows[0].id);
  return { ...invitation, message: String(message || '').slice(0, MESSAGE_MAX) };
}

/** Pending, unexpired invitations addressed to a user. */
async function listIncoming(userId) {
  await expireStale();
  const result = await pool.query(
    `SELECT ${INVITE_COLUMNS},
            r.name AS "roomName", r.is_private AS "roomPrivate",
            s.name AS "senderName", COALESCE(s.image, s."avatarUrl") AS "senderAvatar"
     FROM voice_invitations i
     JOIN voice_rooms r ON r.id = i.room_id
     JOIN "user" s ON s.id = i.sender_id
     WHERE i.recipient_id = $1 AND i.status = 'pending' AND i.expires_at > NOW()
     ORDER BY i.created_at DESC`,
    [userId]
  );
  return result.rows;
}

/** All invitations for a room (owner view). */
async function listForRoom(roomId) {
  await expireStale();
  const result = await pool.query(
    `SELECT ${INVITE_COLUMNS},
            u.name AS "recipientName", COALESCE(u.image, u."avatarUrl") AS "recipientAvatar"
     FROM voice_invitations i
     JOIN "user" u ON u.id = i.recipient_id
     WHERE i.room_id = $1
     ORDER BY i.created_at DESC`,
    [roomId]
  );
  return result.rows;
}

/**
 * Accept or decline. Validates that the acting user is the recipient, that the
 * invitation is still pending and unexpired. On accept the user is added to the
 * room as a member.
 */
async function respond(invitationId, userId, action) {
  if (!['accept', 'decline'].includes(action)) {
    const err = new Error('action must be accept or decline');
    err.code = 'INVALID_ACTION';
    throw err;
  }

  await expireStale();

  const invitation = await getInvitation(invitationId);
  if (!invitation) {
    const err = new Error('Invitation not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (invitation.recipientId !== userId) {
    // Do not leak existence to non-recipients.
    const err = new Error('This invitation is not yours');
    err.code = 'FORBIDDEN';
    throw err;
  }

  // Expiry takes precedence over the generic "not pending" case so the client
  // gets an accurate reason (expireStale() may already have flipped the row).
  const isPastDue = new Date(invitation.expiresAt) <= new Date();
  if (invitation.status === 'expired' || (invitation.status === 'pending' && isPastDue)) {
    if (invitation.status === 'pending') {
      await pool.query(`UPDATE voice_invitations SET status = 'expired' WHERE id = $1`, [invitationId]);
    }
    const err = new Error('Invitation has expired');
    err.code = 'EXPIRED';
    throw err;
  }

  if (invitation.status !== 'pending') {
    const err = new Error(`Invitation already ${invitation.status}`);
    err.code = 'NOT_PENDING';
    throw err;
  }

  const status = action === 'accept' ? 'accepted' : 'declined';
  await pool.query(
    `UPDATE voice_invitations SET status = $1, responded_at = NOW() WHERE id = $2`,
    [status, invitationId]
  );

  if (action === 'accept') {
    await pool.query(
      `INSERT INTO voice_room_members (room_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [invitation.roomId, userId]
    );
  }

  return { ...invitation, status };
}

/** Revoke every pending invitation for a room (used on room deletion). */
async function revokeForRoom(roomId) {
  await pool.query(
    `UPDATE voice_invitations SET status = 'revoked', responded_at = NOW()
     WHERE room_id = $1 AND status = 'pending'`,
    [roomId]
  );
}

module.exports = {
  createInvitation,
  getInvitation,
  listIncoming,
  listForRoom,
  respond,
  revokeForRoom,
  expireStale,
  DEFAULT_TTL_MINUTES,
  MAX_TTL_MINUTES,
};
