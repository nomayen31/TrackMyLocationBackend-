const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const rooms = require('../voice/voice-room.service');
const invitations = require('../voice/invitation.service');
const livekit = require('../voice/livekit');
const presence = require('../voice/presence');

// Every route in this file requires a valid session (reuses Better Auth).
router.use(authMiddleware);

// GET /api/voice/config  -> safe client bootstrap (URL only — NEVER the secret)
router.get('/config', (req, res) => {
  const { configured, url } = livekit.describeConfig();
  res.json({ configured, livekitUrl: url, tokenTtl: livekit.TOKEN_TTL });
});

// GET /api/voice/rooms  -> rooms this user may see (public + their private ones)
router.get('/rooms', async (req, res) => {
  try {
    const list = await rooms.listRooms(req.user.id);
    res.json({
      rooms: list.map((r) => ({ ...r, liveCount: presence.count(r.id) })),
    });
  } catch (err) {
    console.error('List voice rooms error:', err);
    res.status(500).json({ error: 'Failed to load voice rooms' });
  }
});

// POST /api/voice/rooms  -> create (REST equivalent of voice:room:create)
router.post('/rooms', async (req, res) => {
  try {
    const { name, isPrivate, maxParticipants, groupId } = req.body || {};
    const room = await rooms.createRoom({
      name,
      ownerId: req.user.id,
      isPrivate: Boolean(isPrivate),
      maxParticipants,
      groupId: groupId || null,
    });

    const io = req.app.get('io');
    if (io) io.emit('voice:room:updated', { room: { ...room, liveCount: 0 }, action: 'created' });

    res.status(201).json({ room });
  } catch (err) {
    if (err.code === 'INVALID_NAME') return res.status(400).json({ error: err.message });
    console.error('Create voice room error:', err);
    res.status(500).json({ error: 'Failed to create the voice room' });
  }
});

// GET /api/voice/rooms/:roomId  -> room detail + allowed members
router.get('/rooms/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const access = await rooms.canJoin(roomId, req.user.id);
    if (!access.ok && access.reason === 'not_found') {
      return res.status(404).json({ error: 'Room not found' });
    }
    if (!access.ok) {
      return res.status(403).json({ error: 'You do not have access to this room' });
    }

    const members = await rooms.listMembers(roomId);
    res.json({ room: access.room, members });
  } catch (err) {
    console.error('Get voice room error:', err);
    res.status(500).json({ error: 'Failed to load the room' });
  }
});

// GET /api/voice/invitations  -> pending invitations for the signed-in user
router.get('/invitations', async (req, res) => {
  try {
    const list = await invitations.listIncoming(req.user.id);
    res.json({ invitations: list });
  } catch (err) {
    console.error('List voice invitations error:', err);
    res.status(500).json({ error: 'Failed to load invitations' });
  }
});

module.exports = router;
