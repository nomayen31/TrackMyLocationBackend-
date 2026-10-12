/**
 * stories — shared access rules for story privacy tiers and view-once.
 *
 * Privacy tiers:
 *   group    -> only members of the trip the story was posted to
 *   global   -> every connected user
 *   selected -> only users listed in story_audience
 *
 * View-once:
 *   A view-once story disappears for a viewer after their first view
 *   (tracked in story_views). The author can still see their own.
 *
 * The SQL fragments below are parameterised by position, so callers control
 * which `$n` holds the viewer id and (optionally) the group id.
 */

/**
 * SQL predicate: "viewer $viewer can see story s".
 * Pass an array of the parameters already in scope is not possible, so callers
 * append the viewer param themselves — this only returns the WHERE body.
 */
function visibilityPredicate(viewer = '$1') {
  return `(
    s.user_id = ${viewer}
    OR s.privacy = 'global'
    OR (s.privacy = 'group' AND s.group_id IN (
         SELECT group_id FROM group_members WHERE user_id = ${viewer}
       ))
    OR (s.privacy = 'selected' AND EXISTS (
         SELECT 1 FROM story_audience sa
         WHERE sa.story_id = s.id AND sa.user_id = ${viewer}
       ))
  )`;
}

/**
 * SQL predicate: hide stories already consumed when view-once applies.
 * `viewer` is the viewer id param, `viewed` is the `story_views` alias joined
 * on that viewer.
 */
function viewOncePredicate(viewer = '$1', viewed = 'sv') {
  return `(s.view_once = FALSE OR s.user_id = ${viewer} OR ${viewed}.viewer_id IS NULL)`;
}

/** Can `viewerId` see this story row (already loaded)? */
async function canView(storyRow, viewerId, pool) {
  if (!storyRow) return false;
  if (storyRow.user_id === viewerId) return true;
  if (storyRow.expires_at && new Date(storyRow.expires_at) <= new Date()) return false;

  if (storyRow.privacy === 'global') return true;

  if (storyRow.privacy === 'group') {
    if (!storyRow.group_id) return false;
    const r = await pool.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [storyRow.group_id, viewerId]
    );
    return r.rows.length > 0;
  }

  if (storyRow.privacy === 'selected') {
    const r = await pool.query(
      'SELECT 1 FROM story_audience WHERE story_id = $1 AND user_id = $2',
      [storyRow.id, viewerId]
    );
    return r.rows.length > 0;
  }

  return false;
}

module.exports = { visibilityPredicate, viewOncePredicate, canView };
