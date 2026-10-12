/**
 * storySocket — trip stories over Socket.IO (media + text, privacy, view-once).
 *
 *   post-story -> stores the story in PostgreSQL and fans `story-updated` out
 *                 to exactly the people allowed to see it.
 *
 * Stories expire automatically 24h after posting; the REST endpoints in
 * routes/storyRoutes.js only ever return still-active rows.
 *
 * The primary story path is REST (POST /api/stories) because it also handles
 * audience rows transactionally — this socket handler mirrors it for clients
 * that prefer a single realtime call.
 */
const pool = require('../config/db');

const STORY_TTL_HOURS = 24;
const MAX_MEDIA_LENGTH = 7 * 1024 * 1024; // ~7 MB of base64 text
const PRIVACY_TIERS = ['group', 'global', 'selected'];

module.exports = function storySocket(io, socket) {
  const me = socket.user;

  socket.on('post-story', async (payload, ack) => {
    const fail = (error) => typeof ack === 'function' && ack({ error });
    try {
      const {
        groupId = null,
        media = null,
        mediaType,
        text = '',
        caption = '',
        privacy = 'group',
        audienceIds = [],
        viewOnce = false,
      } = payload || {};

      const type = mediaType || (media ? 'image' : 'text');
      if (!['image', 'video', 'text'].includes(type)) return fail('Unsupported story type');
      if (!PRIVACY_TIERS.includes(privacy)) return fail('Invalid privacy');
      if (privacy === 'group' && !groupId) return fail('Group stories need a groupId');
      if (privacy === 'selected' && (!Array.isArray(audienceIds) || audienceIds.length === 0)) {
        return fail('Select at least one person');
      }

      const body = String(text || '').trim().slice(0, 500);
      if (type === 'text') {
        if (!body) return fail('A text story needs text');
      } else {
        const data = String(media || '');
        if (!data) return fail('This story needs media');
        if (data.length > MAX_MEDIA_LENGTH) return fail('Story media is too large (max ~5 MB)');
        if (!/^data:(image|video)\//i.test(data) && !/^https?:\/\//i.test(data)) {
          return fail('Story media must be an image or video');
        }
      }

      if (groupId) {
        const membership = await pool.query(
          'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
          [groupId, me.id]
        );
        if (membership.rows.length === 0) return fail('You are not a member of this trip');
      }

      const client = await pool.connect();
      let storyId;
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO stories
             (user_id, group_id, media, media_type, text_content, caption, privacy, view_once, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(hours => $9::int))
           RETURNING id`,
          [
            me.id,
            groupId,
            type === 'text' ? null : String(media),
            type,
            type === 'text' ? body : null,
            String(caption || '').trim().slice(0, 200),
            privacy,
            Boolean(viewOnce),
            STORY_TTL_HOURS,
          ]
        );
        storyId = inserted.rows[0].id;

        if (privacy === 'selected') {
          const ids = [...new Set(audienceIds.map(String))].filter((id) => id && id !== me.id);
          for (const uid of ids) {
            await client.query(
              'INSERT INTO story_audience (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [storyId, uid]
            );
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const saved = await pool.query(
        `SELECT s.id, s.user_id AS "userId", s.group_id AS "groupId", s.media,
                s.media_type AS "mediaType", s.text_content AS "text", s.caption,
                s.privacy, s.view_once AS "viewOnce", s.created_at AS "createdAt",
                s.expires_at AS "expiresAt", $2::text AS name,
                $3::text AS "avatarUrl", FALSE AS viewed
         FROM stories s WHERE s.id = $1`,
        [storyId, me.name, me.image || me.avatarUrl || null]
      );
      const story = saved.rows[0];

      // Fan out to exactly the allowed audience.
      if (story.privacy === 'group' && story.groupId) {
        io.to(`group_${story.groupId}`).emit('story-updated', story);
      } else if (story.privacy === 'selected') {
        for (const uid of [...new Set(audienceIds.map(String))]) {
          io.to(`user_${uid}`).emit('story-updated', story);
        }
      } else if (story.privacy === 'global') {
        io.emit('story-updated', story);
      }
      io.to(`user_${me.id}`).emit('story-updated', story);

      if (typeof ack === 'function') ack({ ok: true, story });
    } catch (err) {
      console.error('Error saving story:', err);
      fail('Could not post story');
    }
  });
};
