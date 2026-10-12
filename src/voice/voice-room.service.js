/**
 * voice-room.service — all room persistence and authorization rules.
 *
 * Uses the project's existing pg pool (see ../../config/db). Written as a small
 * repository so it could be swapped for Prisma later without touching callers.
 *
 * Server-side authorization lives here: nothing trusts a client-supplied room
 * id, owner id or privacy flag from the client without these checks.
 */
const pool = require('../config/db');
const { roomNameFor } = require('./livekit');

const ROOM_COLUMNS = `
  r.id, r.name, r.owner_id AS "ownerId", r.is_private AS "isPrivate",
  r.max_participants AS "maxParticipants", r.group_id AS "groupId",
  r.livekit_room AS "livekitRoom", r.created_at AS "createdAt", r.updated_at AS "updatedAt"
`;

const NAME_MAX = 80;
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 50;

function clampParticipants(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 8;
  return Math.min(MAX_PARTICIPANTS, Math.max(MIN_PARTICIPANTS, Math.round(n)));
}

function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
}

/* ------------------------------------------------------------------ reads */

async function getRoom(roomId) {
  const result = await pool.query(
    `SELECT ${ROOM_COLUMNS}, u.name AS "ownerName",
            COALESCE(u.image, u."avatarUrl") AS "ownerAvatar",
            (SELECT COUNT(*)::int FROM voice_room_members m WHERE m.room_id = r.id) AS "memberCount"
     FROM voice_rooms r
     JOIN "user" u ON u.id = r.owner_id
     WHERE r.id = $1`,
    [roomId]
  );
  return result.rows[0] || null;
}

/**
 * Rooms the user may see: every public room + private rooms they belong to.
 * `isMember`/`role` let the UI show join vs. invite affordances.
 */
async function listRooms(userId) {
  const result = await pool.query(
    `SELECT ${ROOM_COLUMNS}, u.name AS "ownerName",
            COALESCE(u.image, u."avatarUrl") AS "ownerAvatar",
            (SELECT COUNT(*)::int FROM voice_room_members m WHERE m.room_id = r.id) AS "memberCount",
            EXISTS (SELECT 1 FROM voice_room_members m WHERE m.room_id = r.id AND m.user_id = $1) AS "isMember",
            (SELECT role FROM voice_room_members m WHERE m.room_id = r.id AND m.user_id = $1) AS "role"
     FROM voice_rooms r
     JOIN "user" u ON u.id = r.owner_id
     WHERE r.is_private = FALSE
        OR EXISTS (SELECT 1 FROM voice_room_members m WHERE m.room_id = r.id AND m.user_id = $1)
        OR (r.group_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM group_members gm WHERE gm.group_id = r.group_id AND gm.user_id = $1))
     ORDER BY r.created_at DESC`,
    [userId]
  );
  return result.rows;
}

/** Users who are allowed in (owners included). */
async function listMembers(roomId) {
  const result = await pool.query(
    `SELECT m.user_id AS "userId", m.role, m.joined_at AS "joinedAt",
            u.name, COALESCE(u.image, u."avatarUrl") AS "avatarUrl", u.phone, u.social
     FROM voice_room_members m
     JOIN "user" u ON u.id = m.user_id
     WHERE m.room_id = $1
     ORDER BY m.joined_at ASC`,
    [roomId]
  );
  return result.rows;
}

async function isMember(roomId, userId) {
  const r = await pool.query(
    'SELECT role FROM voice_room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return r.rows[0] || null;
}

async function isBanned(roomId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM voice_room_bans WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return r.rows.length > 0;
}

/**
 * Core access rule. Returns { ok, reason, room, role }.
 * Owners and members always pass for their own room.
 */
async function canJoin(roomId, userId) {
  const room = await getRoom(roomId);
  if (!room) return { ok: false, reason: 'not_found' };

  if (await isBanned(roomId, userId)) return { ok: false, reason: 'banned', room };

  const membership = await isMember(roomId, userId);
  if (membership) return { ok: true, room, role: membership.role };

  if (!room.isPrivate) return { ok: true, room, role: null };

  return { ok: false, reason: 'invite_required', room };
}

/* ----------------------------------------------------------------- writes */

async function createRoom({ name, ownerId, isPrivate = false, maxParticipants = 8, groupId = null }) {
  const clean = cleanName(name);
  if (!clean) {
    const err = new Error('Room name is required');
    err.code = 'INVALID_NAME';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert once to get the id, then derive the LiveKit room name from it so
    // the client can never choose the media room.
    const inserted = await client.query(
      `INSERT INTO voice_rooms (name, owner_id, is_private, max_participants, group_id, livekit_room)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [clean, ownerId, Boolean(isPrivate), clampParticipants(maxParticipants), groupId || null, `pending_${Date.now()}`]
    );
    const id = inserted.rows[0].id;

    await client.query('UPDATE voice_rooms SET livekit_room = $1 WHERE id = $2', [roomNameFor(id), id]);
    await client.query(
      `INSERT INTO voice_room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT DO NOTHING`,
      [id, ownerId]
    );

    await client.query('COMMIT');
    return getRoom(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateRoom(roomId, { name, isPrivate, maxParticipants }) {
  const sets = [];
  const values = [];
  if (name !== undefined) {
    const clean = cleanName(name);
    if (!clean) {
      const err = new Error('Room name cannot be empty');
      err.code = 'INVALID_NAME';
      throw err;
    }
    values.push(clean);
    sets.push(`name = $${values.length}`);
  }
  if (isPrivate !== undefined) {
    values.push(Boolean(isPrivate));
    sets.push(`is_private = $${values.length}`);
  }
  if (maxParticipants !== undefined) {
    values.push(clampParticipants(maxParticipants));
    sets.push(`max_participants = $${values.length}`);
  }
  if (sets.length === 0) return getRoom(roomId);

  values.push(roomId);
  await pool.query(
    `UPDATE voice_rooms SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
    values
  );
  return getRoom(roomId);
}

async function deleteRoom(roomId) {
  // Cascades remove members, invitations and bans.
  await pool.query('DELETE FROM voice_rooms WHERE id = $1', [roomId]);
}

async function addMember(roomId, userId, role = 'member') {
  await pool.query(
    `INSERT INTO voice_room_members (room_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [roomId, userId, role]
  );
}

async function removeMember(roomId, userId) {
  await pool.query('DELETE FROM voice_room_members WHERE room_id = $1 AND user_id = $2', [
    roomId,
    userId,
  ]);
}

async function banUser(roomId, userId, bannedBy) {
  await pool.query(
    `INSERT INTO voice_room_bans (room_id, user_id, banned_by) VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [roomId, userId, bannedBy]
  );
  await removeMember(roomId, userId);
}

module.exports = {
  getRoom,
  listRooms,
  listMembers,
  isMember,
  isBanned,
  canJoin,
  createRoom,
  updateRoom,
  deleteRoom,
  addMember,
  removeMember,
  banUser,
  clampParticipants,
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
};
