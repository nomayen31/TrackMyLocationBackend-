const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');
const { visibilityPredicate, viewOncePredicate, canView } = require('../stories');

// Every route in this file requires a valid session.
router.use(authMiddleware);

const MAX_MEDIA_LENGTH = 7 * 1024 * 1024; // ~7 MB of base64 text
const PRIVACY_TIERS = ['group', 'global', 'selected'];

/** Returns the membership row (or null) for a user in a group. */
async function getMembership(groupId, userId) {
  const result = await pool.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0] || null;
}

// Story columns + author + viewer-specific `viewed` flag.
// View-once stories that the viewer hasn't opened yet are "locked": their media
// and text are withheld here and only returned once, by POST /:id/view.
const STORY_SELECT = `
  SELECT s.id,
         s.user_id    AS "userId",
         s.group_id   AS "groupId",
         CASE WHEN s.view_once AND s.user_id <> $1 AND sv.viewer_id IS NULL
              THEN NULL ELSE s.media END AS media,
         s.media_type AS "mediaType",
         CASE WHEN s.view_once AND s.user_id <> $1 AND sv.viewer_id IS NULL
              THEN NULL ELSE s.text_content END AS text,
         CASE WHEN s.view_once AND s.user_id <> $1 AND sv.viewer_id IS NULL
              THEN TRUE ELSE FALSE END AS locked,
         s.caption,
         s.privacy,
         s.view_once  AS "viewOnce",
         s.created_at AS "createdAt",
         s.expires_at AS "expiresAt",
         u.name,
         COALESCE(u.image, u."avatarUrl") AS "avatarUrl",
         g.name AS "groupName",
         (sv.viewer_id IS NOT NULL) AS viewed
  FROM stories s
  JOIN "user" u ON u.id = s.user_id
  LEFT JOIN groups g ON g.id = s.group_id
  LEFT JOIN story_views sv ON sv.story_id = s.id AND sv.viewer_id = $1
`;

// GET /api/stories/feed  -> every active story visible to the current user,
// across all privacy tiers (group + global + selected + own).
router.get('/feed', async (req, res) => {
  try {
    const result = await pool.query(
      `${STORY_SELECT}
       WHERE s.expires_at > NOW()
         AND ${visibilityPredicate('$1')}
         AND ${viewOncePredicate('$1', 'sv')}
       ORDER BY s.created_at DESC
       LIMIT 200`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Story feed error:', err);
    res.status(500).json({ error: 'Failed to fetch story feed' });
  }
});

// GET /api/stories/group/:groupId  -> active stories shared with a trip
router.get('/group/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const result = await pool.query(
      `${STORY_SELECT}
       WHERE s.group_id = $2
         AND s.expires_at > NOW()
         AND ${visibilityPredicate('$1')}
         AND ${viewOncePredicate('$1', 'sv')}
       ORDER BY s.created_at ASC`,
      [req.user.id, groupId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List group stories error:', err);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
});

// GET /api/stories/user/:userId  -> active stories by one member, visible to me
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `${STORY_SELECT}
       WHERE s.user_id = $2
         AND s.expires_at > NOW()
         AND ${visibilityPredicate('$1')}
         AND ${viewOncePredicate('$1', 'sv')}
       ORDER BY s.created_at ASC`,
      [req.user.id, userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List user stories error:', err);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
});

// POST /api/stories  -> create a story
// body: { groupId?, media?, mediaType?, text?, caption?, privacy?, audienceIds?, viewOnce? }
async function createStoryHandler(req, res) {
  try {
    const {
      groupId = null,
      media = null,
      mediaType = media ? 'image' : 'text',
      text = '',
      caption = '',
      privacy = 'group',
      audienceIds = [],
      viewOnce = false,
    } = req.body || {};

    if (!PRIVACY_TIERS.includes(privacy)) {
      return res.status(400).json({ error: 'privacy must be group, global or selected' });
    }
    if (privacy === 'group' && !groupId) {
      return res.status(400).json({ error: 'group privacy requires a groupId' });
    }
    if (privacy === 'selected' && (!Array.isArray(audienceIds) || audienceIds.length === 0)) {
      return res.status(400).json({ error: 'selected privacy requires audienceIds' });
    }

    const type = ['image', 'video', 'text'].includes(mediaType) ? mediaType : 'image';
    const body = String(text || '').trim().slice(0, 500);

    if (type === 'text') {
      if (!body) return res.status(400).json({ error: 'A text story needs text' });
    } else {
      const data = String(media || '');
      if (!data) return res.status(400).json({ error: 'This story needs media' });
      if (data.length > MAX_MEDIA_LENGTH) {
        return res.status(413).json({ error: 'Story media is too large (max ~5 MB)' });
      }
      if (!/^data:(image|video)\//i.test(data) && !/^https?:\/\//i.test(data)) {
        return res.status(400).json({ error: 'Story media must be an image or video' });
      }
    }

    if (groupId) {
      const membership = await getMembership(groupId, req.user.id);
      if (!membership) {
        return res.status(403).json({ error: 'You are not a member of this group' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO stories
           (user_id, group_id, media, media_type, text_content, caption, privacy, view_once, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '24 hours')
         RETURNING id`,
        [
          req.user.id,
          groupId,
          type === 'text' ? null : String(media),
          type,
          type === 'text' ? body : null,
          String(caption || '').trim().slice(0, 200),
          privacy,
          Boolean(viewOnce),
        ]
      );
      const storyId = result.rows[0].id;

      // Persist the "selected people" audience.
      if (privacy === 'selected') {
        const ids = [...new Set(audienceIds.map(String))].filter((id) => id && id !== req.user.id);
        for (const uid of ids) {
          await client.query(
            'INSERT INTO story_audience (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [storyId, uid]
          );
        }
      }

      await client.query('COMMIT');

      // Re-select so the payload matches the list shape.
      const saved = await pool.query(`${STORY_SELECT} WHERE s.id = $2`, [req.user.id, storyId]);
      const story = saved.rows[0];

      broadcastStory(req, story, audienceIds);
      res.status(201).json({ story });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Create story error:', err);
    res.status(500).json({ error: 'Failed to create story' });
  }
}

router.post('/', createStoryHandler);

/**
 * Fan a new story out to exactly the people allowed to see it:
 *   group    -> the trip room
 *   selected -> each audience member's personal room
 *   global   -> every connected socket
 * The author always receives it too.
 */
function broadcastStory(req, story, audienceIds = []) {
  const io = req.app.get('io');
  if (!io || !story) return;

  if (story.privacy === 'group' && story.groupId) {
    io.to(`group_${story.groupId}`).emit('story-updated', story);
  } else if (story.privacy === 'selected') {
    const ids = [...new Set(audienceIds.map(String))];
    for (const uid of ids) io.to(`user_${uid}`).emit('story-updated', story);
  } else if (story.privacy === 'global') {
    io.emit('story-updated', story);
  }
  io.to(`user_${story.userId}`).emit('story-updated', story);
}

// POST /api/stories/:id/view  -> mark a story as viewed (drives view-once).
// For a view-once story this is the ONLY place its media/text is returned, and
// only on the first successful view (afterwards the feed omits it and this
// endpoint answers 410 Gone).
router.post('/:id/view', async (req, res) => {
  try {
    const { id } = req.params;

    const found = await pool.query(
      `SELECT id, user_id, group_id, privacy, view_once, media_type, media,
              text_content, expires_at
       FROM stories WHERE id = $1`,
      [id]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }
    const story = found.rows[0];

    if (!(await canView(story, req.user.id, pool))) {
      return res.status(403).json({ error: 'This story is not shared with you' });
    }

    const isOwn = story.user_id === req.user.id;

    // Someone else's view-once story that this user already consumed.
    if (story.view_once && !isOwn) {
      const seen = await pool.query(
        'SELECT 1 FROM story_views WHERE story_id = $1 AND viewer_id = $2',
        [id, req.user.id]
      );
      if (seen.rows.length > 0) {
        return res.status(410).json({ error: 'This story has already been viewed', viewOnce: true });
      }
    }

    if (!isOwn) {
      await pool.query(
        `INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2)
         ON CONFLICT (story_id, viewer_id) DO NOTHING`,
        [id, req.user.id]
      );
    }

    // Reveal the payload once for a one-time story.
    const payload =
      story.view_once && !isOwn
        ? { media: story.media, mediaType: story.media_type, text: story.text_content }
        : null;

    res.json({ ok: true, viewOnce: story.view_once, payload });
  } catch (err) {
    console.error('View story error:', err);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

// DELETE /api/stories/:id  -> remove one of your own stories
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING group_id',
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const io = req.app.get('io');
    if (io) io.emit('story-deleted', { id: Number(id) });

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete story error:', err);
    res.status(500).json({ error: 'Failed to delete story' });
  }
});

module.exports = router;
