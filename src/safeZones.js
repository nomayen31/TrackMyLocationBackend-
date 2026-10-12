/**
 * safeZones — dynamic geofenced safe zone store.
 *
 * One zone per group. The radius/enabled flag come from the admin; the centre
 * follows the admin's live GPS position. Zones are cached in memory (so the
 * location hot-path never hits the database) and persisted to
 * `group_safe_zones` for durability across restarts.
 */
const pool = require('./config/db');

const cache = new Map(); // groupId -> zone
const lastPersist = new Map(); // groupId -> timestamp
const PERSIST_INTERVAL_MS = 30_000;

function normalize(row) {
  if (!row) return null;
  return {
    groupId: Number(row.group_id),
    radiusM: Number(row.radius_m),
    enabled: Boolean(row.enabled),
    ownerUserId: row.owner_user_id || null,
    centerLat: row.center_lat != null ? Number(row.center_lat) : null,
    centerLng: row.center_lng != null ? Number(row.center_lng) : null,
    updatedAt: row.updated_at,
  };
}

/** Read the zone from cache, falling back to the database. */
async function loadZone(groupId) {
  const id = Number(groupId);
  if (!Number.isFinite(id)) return null;
  if (cache.has(id)) return cache.get(id);

  const result = await pool.query('SELECT * FROM group_safe_zones WHERE group_id = $1', [id]);
  const zone = normalize(result.rows[0]);
  if (zone) cache.set(id, zone);
  return zone;
}

function getZone(groupId) {
  return cache.get(Number(groupId)) || null;
}

function setZone(zone) {
  if (!zone) return null;
  cache.set(Number(zone.groupId), zone);
  return zone;
}

/** Create or update the zone configuration. */
async function upsertZone({ groupId, radiusM, enabled, ownerUserId, centerLat, centerLng }) {
  const result = await pool.query(
    `INSERT INTO group_safe_zones
       (group_id, radius_m, enabled, owner_user_id, center_lat, center_lng, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (group_id) DO UPDATE SET
       radius_m      = EXCLUDED.radius_m,
       enabled       = EXCLUDED.enabled,
       owner_user_id = EXCLUDED.owner_user_id,
       center_lat    = COALESCE(EXCLUDED.center_lat, group_safe_zones.center_lat),
       center_lng    = COALESCE(EXCLUDED.center_lng, group_safe_zones.center_lng),
       updated_at    = NOW()
     RETURNING *`,
    [groupId, radiusM, enabled, ownerUserId, centerLat ?? null, centerLng ?? null]
  );
  return setZone(normalize(result.rows[0]));
}

/** Turn the zone off (keeps the row so the radius is remembered). */
async function disableZone(groupId) {
  const result = await pool.query(
    'UPDATE group_safe_zones SET enabled = FALSE, updated_at = NOW() WHERE group_id = $1 RETURNING *',
    [groupId]
  );
  if (result.rows.length === 0) return null;
  return setZone(normalize(result.rows[0]));
}

function clearZone(groupId) {
  cache.delete(Number(groupId));
  lastPersist.delete(Number(groupId));
}

/**
 * Move the centre to the owner's live position. The in-memory value updates
 * instantly; the database write is throttled to once every ~30 s.
 */
function moveCenter(groupId, lat, lng) {
  const id = Number(groupId);
  const zone = cache.get(id);
  if (!zone) return null;

  zone.centerLat = Number(lat);
  zone.centerLng = Number(lng);
  zone.updatedAt = new Date().toISOString();

  const now = Date.now();
  if (now - (lastPersist.get(id) || 0) > PERSIST_INTERVAL_MS) {
    lastPersist.set(id, now);
    pool
      .query(
        'UPDATE group_safe_zones SET center_lat = $1, center_lng = $2, updated_at = NOW() WHERE group_id = $3',
        [lat, lng, id]
      )
      .catch((err) => console.error('Persist safe-zone centre failed:', err.message));
  }
  return zone;
}

module.exports = { loadZone, getZone, setZone, upsertZone, disableZone, clearZone, moveCenter };
