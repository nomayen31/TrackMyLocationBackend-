const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// Every route in this file requires a valid session.
router.use(authMiddleware);

/** Returns the membership row (or null) for a user in a group. */
async function getMembership(groupId, userId) {
  const result = await pool.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0] || null;
}

/** Convert a decimal amount to integer cents. */
function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

/** Convert integer cents back to a 2-decimal number. */
function toAmount(cents) {
  return Number((cents / 100).toFixed(2));
}

// POST /api/expenses  ->  { groupId, amount, description }
// The payer is taken from the authenticated session (never the request body).
router.post('/', async (req, res) => {
  try {
    const { groupId, amount, description } = req.body || {};

    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required' });
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const result = await pool.query(
      `INSERT INTO expenses (group_id, paid_by, amount, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, group_id, paid_by, amount, description, created_at`,
      [groupId, req.user.id, parsedAmount, description || '']
    );

    res.status(201).json({ expense: result.rows[0] });
  } catch (err) {
    console.error('Add expense error:', err);
    res.status(500).json({ error: 'Failed to add expense' });
  }
});

// GET /api/expenses/:groupId  -> list expenses in a group
router.get('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const result = await pool.query(
      `SELECT e.id, e.group_id, e.paid_by, e.amount, e.description, e.created_at, u.name AS paid_by_name
       FROM expenses e
       JOIN "user" u ON u.id = e.paid_by
       WHERE e.group_id = $1
       ORDER BY e.created_at ASC, e.id ASC`,
      [groupId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List expenses error:', err);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// GET /api/expenses/summary/:groupId
// -> total spend + how much each member has paid and still owes.
router.get('/summary/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    // 1. Every member of the group.
    const membersResult = await pool.query(
      `SELECT u.id, u.name
       FROM group_members gm
       JOIN "user" u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY u.id ASC`,
      [groupId]
    );
    const members = membersResult.rows;

    if (members.length === 0) {
      return res.json({ total: 0, members: [] });
    }

    // 2. Sum what each member paid.
    const paidResult = await pool.query(
      `SELECT paid_by, SUM(amount)::numeric AS paid
       FROM expenses
       WHERE group_id = $1
       GROUP BY paid_by`,
      [groupId]
    );

    const paidCents = new Map();
    for (const m of members) paidCents.set(m.id, 0);

    let totalCents = 0;
    for (const row of paidResult.rows) {
      const cents = toCents(row.paid);
      totalCents += cents;
      if (paidCents.has(row.paid_by)) {
        paidCents.set(row.paid_by, cents);
      }
    }

    // 3. Equal split (whole-cent remainder distributed to the first members).
    const n = members.length;
    const shareBase = Math.floor(totalCents / n);
    let remainder = totalCents - shareBase * n;

    const summary = members.map((m) => {
      const paid = paidCents.get(m.id);
      const share = shareBase + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;

      return {
        userId: m.id,
        name: m.name,
        spent: toAmount(paid),
        share: toAmount(share),
        owes: toAmount(Math.max(0, share - paid)),
        receivable: toAmount(Math.max(0, paid - share)),
      };
    });

    res.json({ total: toAmount(totalCents), members: summary });
  } catch (err) {
    console.error('Expense summary error:', err);
    res.status(500).json({ error: 'Failed to calculate expense summary' });
  }
});

// GET /api/expenses/:groupId/balance  -> equal-split summary + who owes whom
router.get('/:groupId/balance', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    // 1. Every member of the group.
    const membersResult = await pool.query(
      `SELECT u.id, u.name
       FROM group_members gm
       JOIN "user" u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY u.id ASC`,
      [groupId]
    );
    const members = membersResult.rows;

    if (members.length === 0) {
      return res.json({ total: 0, perPerson: [], settlements: [] });
    }

    // 2. All expenses in the group.
    const expensesResult = await pool.query(
      'SELECT paid_by, amount FROM expenses WHERE group_id = $1',
      [groupId]
    );

    // paidCents per member
    const paidCents = new Map();
    for (const m of members) paidCents.set(m.id, 0);

    let totalCents = 0;
    for (const e of expensesResult.rows) {
      const cents = toCents(e.amount);
      totalCents += cents;
      if (paidCents.has(e.paid_by)) {
        paidCents.set(e.paid_by, paidCents.get(e.paid_by) + cents);
      }
    }

    // 3. Equal split, distributing the remainder one cent at a time so
    //    the balances always sum exactly to zero.
    const n = members.length;
    const shareBase = Math.floor(totalCents / n);
    let remainder = totalCents - shareBase * n;

    const perPerson = members.map((m) => {
      const paid = paidCents.get(m.id);
      const share = shareBase + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      return {
        userId: m.id,
        name: m.name,
        paid: toAmount(paid),
        share: toAmount(share),
        balance: toAmount(paid - share), // + receives, - owes
      };
    });

    // 4. Greedy settlement: pair debtors with creditors.
    const creditors = perPerson
      .filter((p) => p.balance > 0)
      .map((p) => ({ ...p, netCents: toCents(p.balance) }))
      .sort((a, b) => b.netCents - a.netCents);

    const debtors = perPerson
      .filter((p) => p.balance < 0)
      .map((p) => ({ ...p, netCents: -toCents(p.balance) }))
      .sort((a, b) => b.netCents - a.netCents);

    const settlements = [];
    let i = 0;
    let j = 0;
    while (i < creditors.length && j < debtors.length) {
      const creditor = creditors[i];
      const debtor = debtors[j];
      const amountCents = Math.min(creditor.netCents, debtor.netCents);

      settlements.push({
        from: debtor.userId,
        fromName: debtor.name,
        to: creditor.userId,
        toName: creditor.name,
        amount: toAmount(amountCents),
      });

      creditor.netCents -= amountCents;
      debtor.netCents -= amountCents;

      if (creditor.netCents === 0) i += 1;
      if (debtor.netCents === 0) j += 1;
    }

    res.json({
      total: toAmount(totalCents),
      perPerson,
      settlements,
    });
  } catch (err) {
    console.error('Balance error:', err);
    res.status(500).json({ error: 'Failed to calculate balances' });
  }
});

module.exports = router;
