/**
 * reset-groups — clear ALL trip data so you can start fresh.
 *
 * Deletes: groups (which cascades group_members, messages, expenses, stories,
 * safe zones), voice rooms (which cascades voice members, invitations, bans).
 * KEEPS: user accounts, direct messages, and any other account-level data.
 *
 * Usage:
 *   node scripts/reset-groups.js            # dry run — shows what would go
 *   node scripts/reset-groups.js --yes      # actually delete
 */
require('dotenv').config();
const pool = require('../src/config/db');

const confirmed = process.argv.includes('--yes');

const TABLES = [
  ['groups', 'groups'],
  ['group_members', 'memberships'],
  ['messages', 'group messages'],
  ['expenses', 'expenses'],
  ['expense_shares', 'expense shares'],
  ['stories', 'stories'],
  ['story_audience', 'story audiences'],
  ['story_views', 'story views'],
  ['group_safe_zones', 'safe zones'],
  ['voice_rooms', 'voice rooms'],
  ['voice_room_members', 'voice room members'],
  ['voice_invitations', 'voice invitations'],
  ['voice_room_bans', 'voice room bans'],
];

async function counts() {
  const out = {};
  for (const [table, label] of TABLES) {
    const r = await pool.query(`SELECT count(*)::int AS c FROM ${table}`);
    out[label] = r.rows[0].c;
  }
  const users = await pool.query('SELECT count(*)::int AS c FROM "user"');
  out['users (kept)'] = users.rows[0].c;
  const dms = await pool.query('SELECT count(*)::int AS c FROM direct_messages');
  out['direct messages (kept)'] = dms.rows[0].c;
  return out;
}

(async () => {
  const before = await counts();
  console.log('\n📊 Before\n');
  for (const [k, v] of Object.entries(before)) console.log(`  ${k.padEnd(24)} ${v}`);

  if (!confirmed) {
    console.log('\n⚠️  Dry run. Nothing was deleted.');
    console.log('   Re-run with --yes to delete the trip data above.\n');
    await pool.end();
    return;
  }

  console.log('\n🧹 Deleting trip data…\n');
  await pool.query('BEGIN');
  try {
    // Voice rooms first (they may reference groups).
    await pool.query('DELETE FROM voice_rooms');
    // Groups cascade to members, messages, expenses, stories, safe zones.
    await pool.query('DELETE FROM groups');
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }

  const after = await counts();
  console.log('✅ Done\n');
  for (const [k, v] of Object.entries(after)) console.log(`  ${k.padEnd(24)} ${v}`);
  console.log('\nUser accounts were preserved. Create a fresh trip in the app.\n');
})()
  .catch((err) => {
    console.error('❌ Reset failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
