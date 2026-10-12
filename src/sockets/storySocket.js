/**
 * storySocket — trip stories ("short trip stories/photos").
 *
 *   post-story -> stores an image (as a data URL or remote URL) in PostgreSQL
 *                 and broadcasts `story-updated` to the whole group.
 *
 * Stories expire automatically 24h after they are posted; the REST endpoints
 * in routes/storyRoutes.js only ever return still-active rows.
 */
const pool = require('../config/db');

const STORY_TTL_HOURS = 24;
const MAX_MEDIA_LENGTH = 7 * 1024 * 1024; // ~7 MB of base64 text

module.exports = function storySocket(io, socket) {
  const me = socket.user;

  socket.on('post-story', async ({ groupId, media, caption } = {}, ack) => {
    try {
      if (!groupId || !media) {
        if (typeof ack === 'function') ack({ error: 'groupId and media are required' });
        return;
      }

      const data = String(media);
      // Accept an inline image data URL or any http(s) image URL.
      if (!/^data:image\//i.test(data) && !/^https?:\/\//i.test(data)) {
        if (typeof ack === 'function') ack({ error: 'Story must be an image' });
        return;
      }
      if (data.length > MAX_MEDIA_LENGTH) {
        if (typeof ack === 'function') ack({ error: 'Story image is too large (max ~5 MB)' });
        return;
      }

      const membership = await pool.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, me.id]
      );
      if (membership.rows.length === 0) {
        if (typeof ack === 'function') ack({ error: 'You are not a member of this trip' });
        return;
      }

      const result = await pool.query(
        `INSERT INTO stories (user_id, group_id, media, caption, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + make_interval(hours => $5::int))
         RETURNING id, user_id AS "userId", group_id AS "groupId", media, caption,
                   created_at AS "createdAt", expires_at AS "expiresAt"`,
        [me.id, groupId, data, String(caption || '').trim().slice(0, 200), STORY_TTL_HOURS]
      );

      const story = {
        ...result.rows[0],
        userId: me.id,
        name: me.name,
        avatarUrl: me.image || me.avatarUrl || null,
      };

      // Fan out to the group room (the sender is in it too) and, as a safety
      // net, straight to the author in case they have not joined the room yet.
      io.to(`group_${groupId}`).emit('story-updated', story);
      socket.emit('story-updated', story);

      if (typeof ack === 'function') ack({ ok: true, story });
    } catch (err) {
      console.error('Error saving story:', err);
      if (typeof ack === 'function') ack({ error: 'Could not post story' });
    }
  });
};
