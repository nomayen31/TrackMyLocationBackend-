/**
 * Applies schema.sql to the configured database.
 *
 * Every statement uses "IF NOT EXISTS", so this is safe to run repeatedly.
 * Usage:  npm run migrate
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

(async () => {
  const file = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(file, 'utf8');

  try {
    await pool.query(sql);
    console.log('✅ schema.sql applied (tables/indexes are up to date)');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
