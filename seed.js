/**
 * Seed the Trip Tracker database with demo users, groups, expenses, and chat
 * messages so every API can be exercised immediately.
 *
 * Run:  node seed.js
 */
require('dotenv').config();
const crypto = require('crypto');
const { auth } = require('./src/auth');
const pool = require('./src/config/db');

const PASSWORD = 'password123';

const USERS = [
  { name: 'Alice', email: 'alice@trip.com' },
  { name: 'Bob', email: 'bob@trip.com' },
  { name: 'Carol', email: 'carol@trip.com' },
  { name: 'Dave', email: 'dave@trip.com' },
];

const GROUPS = [
  {
    name: 'Sundarbans Adventure',
    invite_code: 'TRIP1234',
    creator: 'alice@trip.com',
    members: ['alice@trip.com', 'bob@trip.com', 'carol@trip.com'],
    expenses: [
      { paid_by: 'alice@trip.com', amount: 300, description: 'Boat tour' },
      { paid_by: 'bob@trip.com', amount: 150, description: 'Fuel' },
      { paid_by: 'carol@trip.com', amount: 60, description: 'Snacks' },
    ],
    messages: [
      { email: 'alice@trip.com', message: "Let's meet at the dock at 8 AM!" },
      { email: 'bob@trip.com', message: 'Sounds good, see you there.' },
      { email: 'carol@trip.com', message: 'Bringing the binoculars 🐅' },
    ],
  },
  {
    name: "Cox's Bazar Beach Trip",
    invite_code: 'BEACH2024',
    creator: 'dave@trip.com',
    members: ['dave@trip.com', 'alice@trip.com', 'bob@trip.com'],
    expenses: [
      { paid_by: 'dave@trip.com', amount: 400, description: 'Resort booking' },
      { paid_by: 'alice@trip.com', amount: 90, description: 'Lunch' },
    ],
    messages: [
      { email: 'dave@trip.com', message: 'Beach trip this weekend! 🏖️' },
      { email: 'alice@trip.com', message: 'Count me in!' },
    ],
  },
];

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

async function ensureUser({ name, email }) {
  const existing = await pool.query('SELECT id FROM "user" WHERE email = $1', [email]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const { user } = await auth.api.signUpEmail({
    body: { name, email, password: PASSWORD },
  });
  return user.id;
}

async function ensureGroup(group, usersById) {
  const existing = await pool.query(
    'SELECT id FROM groups WHERE invite_code = $1',
    [group.invite_code]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const creatorId = usersById[group.creator];
  const result = await pool.query(
    'INSERT INTO groups (name, invite_code, created_by) VALUES ($1, $2, $3) RETURNING id',
    [group.name, group.invite_code, creatorId]
  );
  return result.rows[0].id;
}

async function addMember(groupId, userId, role) {
  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, user_id) DO NOTHING`,
    [groupId, userId, role]
  );
}

async function seed() {
  console.log('🌱 Seeding Trip Tracker database…\n');

  // 1. Users (created through Better Auth so login works).
  const usersById = {};
  for (const u of USERS) {
    usersById[u.email] = await ensureUser(u);
    console.log(`   ✅ user: ${u.email} (password: ${PASSWORD})`);
  }

  // 2. Groups, members, expenses, messages.
  for (const g of GROUPS) {
    const groupId = await ensureGroup(g, usersById);

    // Creator is admin, others are members.
    for (const email of g.members) {
      const role = email === g.creator ? 'admin' : 'member';
      await addMember(groupId, usersById[email], role);
    }

    for (const e of g.expenses) {
      await pool.query(
        'INSERT INTO expenses (group_id, paid_by, amount, description) VALUES ($1, $2, $3, $4)',
        [groupId, usersById[e.paid_by], e.amount, e.description]
      );
    }

    for (const m of g.messages) {
      await pool.query(
        'INSERT INTO messages (group_id, user_id, message) VALUES ($1, $2, $3)',
        [groupId, usersById[m.email], m.message]
      );
    }

    console.log(
      `   ✅ group: "${g.name}" (id ${groupId}) invite code: ${g.invite_code}`
    );
  }

  console.log('\n✨ Seeding complete!');
  console.log('   Test login: alice@trip.com / password123');
  console.log('   Swagger UI: http://localhost:5000/api-docs');
}

seed()
  .catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
