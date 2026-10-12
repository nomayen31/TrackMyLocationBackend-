/**
 * Voice service integration tests (rooms + invitations) against the real
 * database. Every room created here is deleted in the cleanup hook, so the
 * suite leaves no residue.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();
const pool = require('../src/config/db');
const rooms = require('../src/voice/voice-room.service');
const invitations = require('../src/voice/invitation.service');
const livekit = require('../src/voice/livekit');

const createdRoomIds = [];
let userA = null;
let userB = null;

/** Two real, existing users to act as owner/invitee. */
async function pickUsers() {
  const res = await pool.query('SELECT id, name FROM "user" ORDER BY "createdAt" ASC LIMIT 2');
  return res.rows;
}

test.before(async () => {
  const users = await pickUsers();
  if (users.length < 2) {
    // Nothing to test against — the suite will fail loudly rather than silently pass.
    throw new Error('Need at least 2 users in the database (run `npm run seed`).');
  }
  [userA, userB] = users;
});

test.after(async () => {
  if (createdRoomIds.length > 0) {
    await pool.query('DELETE FROM voice_rooms WHERE id = ANY($1)', [createdRoomIds]);
  }
  await pool.end();
});

async function makeRoom(overrides = {}) {
  const room = await rooms.createRoom({
    name: `test-room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ownerId: userA.id,
    ...overrides,
  });
  createdRoomIds.push(room.id);
  return room;
}

/* ------------------------------------------------------------------ rooms */

test('createRoom: owner becomes a member and gets a derived LiveKit room name', async () => {
  const room = await makeRoom();
  assert.ok(room.id, 'room has an id');
  assert.equal(room.ownerId, userA.id);
  assert.equal(room.livekitRoom, `voice_room_${room.id}`, 'LiveKit name is derived, not client-supplied');

  const membership = await rooms.isMember(room.id, userA.id);
  assert.ok(membership, 'owner is recorded as a member');
  assert.equal(membership.role, 'owner');
});

test('createRoom: rejects an empty name', async () => {
  await assert.rejects(
    () => rooms.createRoom({ name: '   ', ownerId: userA.id }),
    (err) => err.code === 'INVALID_NAME'
  );
});

test('capacity is clamped to sane bounds', () => {
  assert.equal(rooms.clampParticipants(0), rooms.MIN_PARTICIPANTS);
  assert.equal(rooms.clampParticipants(9999), rooms.MAX_PARTICIPANTS);
  assert.equal(rooms.clampParticipants(12), 12);
  assert.equal(rooms.clampParticipants('nonsense'), 8);
});

test('canJoin: a public room is open to any authenticated user', async () => {
  const room = await makeRoom({ isPrivate: false });
  const access = await rooms.canJoin(room.id, userB.id);
  assert.equal(access.ok, true);
  assert.equal(access.role, null, 'non-members join with no role');
});

test('canJoin: a private room requires membership (or an invitation)', async () => {
  const room = await makeRoom({ isPrivate: true });

  const denied = await rooms.canJoin(room.id, userB.id);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'invite_required', 'guessing the room id must not be enough');

  await rooms.addMember(room.id, userB.id, 'member');
  const allowed = await rooms.canJoin(room.id, userB.id);
  assert.equal(allowed.ok, true);
});

test('canJoin: an unknown room reports not_found', async () => {
  const access = await rooms.canJoin(999999999, userA.id);
  assert.equal(access.ok, false);
  assert.equal(access.reason, 'not_found');
});

test('banning a user removes membership and blocks re-joining', async () => {
  const room = await makeRoom({ isPrivate: false });
  await rooms.addMember(room.id, userB.id, 'member');
  await rooms.banUser(room.id, userB.id, userA.id);

  assert.equal(await rooms.isMember(room.id, userB.id), null, 'membership revoked');
  const access = await rooms.canJoin(room.id, userB.id);
  assert.equal(access.ok, false);
  assert.equal(access.reason, 'banned');
});

test('deleteRoom cascades members, invitations and bans', async () => {
  const room = await makeRoom({ isPrivate: true });
  // Invite FIRST (inviting an existing member is correctly refused), then add.
  await invitations.createInvitation({ roomId: room.id, senderId: userA.id, recipientId: userB.id });
  await rooms.addMember(room.id, userB.id, 'member');

  await rooms.deleteRoom(room.id);
  createdRoomIds.splice(createdRoomIds.indexOf(room.id), 1);

  const members = await pool.query('SELECT 1 FROM voice_room_members WHERE room_id = $1', [room.id]);
  const invites = await pool.query('SELECT 1 FROM voice_invitations WHERE room_id = $1', [room.id]);
  assert.equal(members.rows.length, 0, 'members cleaned up');
  assert.equal(invites.rows.length, 0, 'invitations cleaned up');
});

/* ------------------------------------------------------------ invitations */

test('invitation: owner can invite, and the invitee can accept', async () => {
  const room = await makeRoom({ isPrivate: true });
  const invite = await invitations.createInvitation({
    roomId: room.id,
    senderId: userA.id,
    recipientId: userB.id,
  });
  assert.equal(invite.status, 'pending');
  assert.equal(invite.recipientId, userB.id);

  const accepted = await invitations.respond(invite.id, userB.id, 'accept');
  assert.equal(accepted.status, 'accepted');

  const membership = await rooms.isMember(room.id, userB.id);
  assert.ok(membership, 'accepting grants room membership');
});

test('invitation: only the recipient may respond', async () => {
  const room = await makeRoom({ isPrivate: true });
  const invite = await invitations.createInvitation({
    roomId: room.id,
    senderId: userA.id,
    recipientId: userB.id,
  });

  // A third party (the sender) must not be able to accept on their behalf.
  await assert.rejects(
    () => invitations.respond(invite.id, userA.id, 'accept'),
    (err) => err.code === 'FORBIDDEN'
  );
});

test('invitation: duplicate pending invites are rejected', async () => {
  const room = await makeRoom({ isPrivate: true });
  await invitations.createInvitation({ roomId: room.id, senderId: userA.id, recipientId: userB.id });

  await assert.rejects(
    () => invitations.createInvitation({ roomId: room.id, senderId: userA.id, recipientId: userB.id }),
    (err) => err.code === 'DUPLICATE_INVITE'
  );
});

test('invitation: you cannot invite yourself or an unknown user', async () => {
  const room = await makeRoom({ isPrivate: true });

  await assert.rejects(
    () => invitations.createInvitation({ roomId: room.id, senderId: userA.id, recipientId: userA.id }),
    (err) => err.code === 'SELF_INVITE'
  );

  await assert.rejects(
    () => invitations.createInvitation({ roomId: room.id, senderId: userA.id, recipientId: 'no-such-user' }),
    (err) => err.code === 'USER_NOT_FOUND'
  );
});

test('invitation: already-members cannot be invited', async () => {
  const room = await makeRoom({ isPrivate: true });
  await rooms.addMember(room.id, userB.id, 'member');

  await assert.rejects(
    () => invitations.createInvitation({ roomId: room.id, senderId: userA.id, recipientId: userB.id }),
    (err) => err.code === 'ALREADY_MEMBER'
  );
});

test('invitation: an expired invitation cannot be accepted', async () => {
  const room = await makeRoom({ isPrivate: true });
  const invite = await invitations.createInvitation({
    roomId: room.id,
    senderId: userA.id,
    recipientId: userB.id,
  });

  // Force it into the past.
  await pool.query(`UPDATE voice_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
    invite.id,
  ]);

  await assert.rejects(
    () => invitations.respond(invite.id, userB.id, 'accept'),
    (err) => err.code === 'EXPIRED'
  );
});

test('invitation: declining does not grant membership', async () => {
  const room = await makeRoom({ isPrivate: true });
  const invite = await invitations.createInvitation({
    roomId: room.id,
    senderId: userA.id,
    recipientId: userB.id,
  });

  const declined = await invitations.respond(invite.id, userB.id, 'decline');
  assert.equal(declined.status, 'declined');
  assert.equal(await rooms.isMember(room.id, userB.id), null, 'no membership after a decline');
});

test('invitation: listIncoming only returns the caller\'s pending invites', async () => {
  const room = await makeRoom({ isPrivate: true });
  await invitations.createInvitation({ roomId: room.id, senderId: userA.id, recipientId: userB.id });

  const forB = await invitations.listIncoming(userB.id);
  assert.ok(forB.some((i) => i.roomId === room.id), 'recipient sees it');

  const forA = await invitations.listIncoming(userA.id);
  assert.ok(!forA.some((i) => i.roomId === room.id), 'sender does not see it in their inbox');
});

/* ---------------------------------------------------------------- livekit */

test('livekit: token is scoped to the room and identity (requires LIVEKIT_API_SECRET)', async (t) => {
  if (!livekit.isConfigured()) {
    t.skip('LIVEKIT_API_SECRET not set — skipping token assertion');
    return;
  }

  const room = await makeRoom();
  const jwt = await livekit.createVoiceToken({
    roomName: room.livekitRoom,
    identity: userA.id,
    name: userA.name,
  });

  // Decode (do NOT verify) purely to assert the claims the SDK produced.
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.sub, userA.id, 'identity is the authenticated user id');
  assert.equal(payload.video.room, room.livekitRoom, 'token is scoped to exactly one room');
  assert.equal(payload.video.roomJoin, true);
  // LiveKit's SDK sets `nbf` (not `iat`); assert the lifetime from it.
  assert.equal(payload.exp - payload.nbf, 900, 'token lifetime is 15 minutes');
});

test('livekit: refuses to mint a token without a room or identity', async (t) => {
  if (!livekit.isConfigured()) {
    t.skip('LIVEKIT_API_SECRET not set');
    return;
  }
  await assert.rejects(() => livekit.createVoiceToken({ roomName: '', identity: 'x' }), (e) => e.code === 'BAD_TOKEN_REQUEST');
  await assert.rejects(() => livekit.createVoiceToken({ roomName: 'r', identity: '' }), (e) => e.code === 'BAD_TOKEN_REQUEST');
});

test('livekit: describeConfig never leaks the secret', () => {
  const described = livekit.describeConfig();
  assert.equal(typeof described.apiSecretSet, 'boolean', 'only a boolean flag, never the value');
  assert.ok(!('apiSecret' in described));
  assert.ok(!JSON.stringify(described).includes('secret"'), 'no secret value in the payload');
});
