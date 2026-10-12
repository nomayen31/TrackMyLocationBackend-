const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// Every route in this file requires a valid session.
router.use(authMiddleware);

const CATEGORIES = ['food', 'transport', 'stay', 'activity', 'shopping', 'tickets', 'other'];
const SPLIT_TYPES = ['equal', 'custom', 'payer'];

/** Returns the membership row (or null) for a user in a group. */
async function getMembership(groupId, userId) {
  const result = await pool.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0] || null;
}

/** Every member of a group. */
async function getMembers(groupId) {
  const result = await pool.query(
    `SELECT u.id, u.name, u.image, u."avatarUrl"
     FROM group_members gm
     JOIN "user" u ON u.id = gm.user_id
     WHERE gm.group_id = $1
     ORDER BY gm.joined_at ASC`,
    [groupId]
  );
  return result.rows;
}

const toCents = (amount) => Math.round(Number(amount) * 100);
const toAmount = (cents) => Number((cents / 100).toFixed(2));

/**
 * Work out who owes what (in cents) for an expense.
 *   equal  -> split evenly across participants, distributing the remainder
 *   custom -> caller-supplied amounts (must add up to the total)
 *   payer  -> the payer keeps the whole amount (personal expense)
 */
function computeShares(totalCents, payerId, participants, splitType, customShares) {
  const people = [...new Set(participants.filter(Boolean))];

  if (splitType === 'payer' || people.length === 0) {
    return new Map([[payerId, totalCents]]);
  }

  if (splitType === 'custom') {
    const map = new Map();
    let sum = 0;
    for (const id of people) {
      const cents = toCents(customShares?.[id] ?? 0);
      if (cents < 0) return null;
      map.set(id, cents);
      sum += cents;
    }
    if (sum !== totalCents) return null; // must balance exactly
    return map;
  }

  // equal
  const map = new Map();
  const base = Math.floor(totalCents / people.length);
  let remainder = totalCents - base * people.length;
  for (const id of people) {
    map.set(id, base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder -= 1;
  }
  return map;
}

// POST /api/expenses
// body: { groupId, amount, description, category?, note?, splitType?, participants?, customShares?, currency? }
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      groupId,
      amount,
      description,
      category = 'other',
      note = '',
      splitType = 'equal',
      participants,
      customShares,
      currency = 'USD',
    } = req.body || {};

    if (!groupId) return res.status(400).json({ error: 'groupId is required' });

    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    const totalCents = toCents(parsed);
    if (totalCents <= 0) return res.status(400).json({ error: 'amount is too small' });

    const cat = CATEGORIES.includes(category) ? category : 'other';
    const mode = SPLIT_TYPES.includes(splitType) ? splitType : 'equal';

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) return res.status(403).json({ error: 'You are not a member of this group' });

    // Resolve participants (default: everyone in the trip).
    const members = await getMembers(groupId);
    const memberIds = new Set(members.map((m) => m.id));
    let people = Array.isArray(participants) && participants.length > 0 ? participants : members.map((m) => m.id);
    people = people.filter((id) => memberIds.has(id));
    if (people.length === 0) people = members.map((m) => m.id);

    const shares = computeShares(totalCents, req.user.id, people, mode, customShares);
    if (!shares) {
      return res.status(400).json({ error: 'Custom split amounts must add up to the total' });
    }

    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO expenses (group_id, paid_by, amount, description, category, split_type, currency, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, group_id, paid_by, amount, description, category, split_type, currency, note, created_at`,
      [
        groupId,
        req.user.id,
        parsed,
        String(description || '').trim().slice(0, 160),
        cat,
        mode,
        String(currency || 'USD').slice(0, 8),
        String(note || '').trim().slice(0, 400),
      ]
    );
    const expense = inserted.rows[0];

    for (const [userId, cents] of shares.entries()) {
      await client.query(
        'INSERT INTO expense_shares (expense_id, user_id, share_amount) VALUES ($1, $2, $3)',
        [expense.id, userId, toAmount(cents)]
      );
    }

    await client.query('COMMIT');

    // Notify the group so open expense panels refresh.
    const io = req.app.get('io');
    if (io) io.to(`group_${groupId}`).emit('expense-updated', { groupId: Number(groupId), action: 'created', expenseId: expense.id });

    res.status(201).json({
      expense: { ...expense, shares: Object.fromEntries([...shares].map(([id, c]) => [id, toAmount(c)])) },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Add expense error:', err);
    res.status(500).json({ error: 'Failed to add expense' });
  } finally {
    client.release();
  }
});

// GET /api/expenses/:groupId  -> expenses with their shares
router.get('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) return res.status(403).json({ error: 'You are not a member of this group' });

    const expenses = await pool.query(
      `SELECT e.id, e.group_id, e.paid_by, e.amount, e.description, e.category,
              e.split_type, e.currency, e.note, e.created_at, u.name AS paid_by_name,
              COALESCE(u.image, u."avatarUrl") AS paid_by_avatar
       FROM expenses e
       JOIN "user" u ON u.id = e.paid_by
       WHERE e.group_id = $1
       ORDER BY e.created_at DESC, e.id DESC`,
      [groupId]
    );

    const shares = await pool.query(
      `SELECT es.expense_id, es.user_id, es.share_amount
       FROM expense_shares es
       JOIN expenses e ON e.id = es.expense_id
       WHERE e.group_id = $1`,
      [groupId]
    );

    const byExpense = new Map();
    for (const s of shares.rows) {
      if (!byExpense.has(s.expense_id)) byExpense.set(s.expense_id, {});
      byExpense.get(s.expense_id)[s.user_id] = Number(s.share_amount);
    }

    res.json(expenses.rows.map((e) => ({ ...e, shares: byExpense.get(e.id) || {} })));
  } catch (err) {
    console.error('List expenses error:', err);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// DELETE /api/expenses/:id  -> remove an expense (its payer or a group admin)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const found = await pool.query('SELECT id, group_id, paid_by FROM expenses WHERE id = $1', [id]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });

    const { group_id: groupId, paid_by: paidBy } = found.rows[0];
    const membership = await getMembership(groupId, req.user.id);
    if (!membership) return res.status(403).json({ error: 'You are not a member of this group' });
    if (paidBy !== req.user.id && membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only the payer or a group admin can delete this' });
    }

    await pool.query('DELETE FROM expenses WHERE id = $1', [id]); // shares cascade

    const io = req.app.get('io');
    if (io) io.to(`group_${group_id}`).emit('expense-updated', { groupId: Number(groupId), action: 'deleted', expenseId: Number(id) });

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete expense error:', err);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

/**
 * Compute balances from real shares.
 * Legacies (expenses created before shares existed) fall back to an equal split
 * across the current members so nothing is lost.
 */
async function buildBalance(groupId) {
  const members = await getMembers(groupId);
  if (members.length === 0) return null;

  const expenses = await pool.query(
    'SELECT id, paid_by, amount, category FROM expenses WHERE group_id = $1',
    [groupId]
  );
  const shares = await pool.query(
    `SELECT es.expense_id, es.user_id, es.share_amount
     FROM expense_shares es JOIN expenses e ON e.id = es.expense_id
     WHERE e.group_id = $1`,
    [groupId]
  );

  const shareMap = new Map(); // expenseId -> { userId: cents }
  for (const s of shares.rows) {
    if (!shareMap.has(s.expense_id)) shareMap.set(s.expense_id, {});
    shareMap.get(s.expense_id)[s.user_id] = toCents(s.share_amount);
  }

  const paid = new Map();
  const owed = new Map();
  const categoryTotals = new Map();
  for (const m of members) {
    paid.set(m.id, 0);
    owed.set(m.id, 0);
  }

  let totalCents = 0;

  for (const e of expenses.rows) {
    const amountCents = toCents(e.amount);
    totalCents += amountCents;
    categoryTotals.set(e.category, (categoryTotals.get(e.category) || 0) + amountCents);
    if (paid.has(e.paid_by)) paid.set(e.paid_by, paid.get(e.paid_by) + amountCents);

    const perPerson = shareMap.get(e.id);
    if (perPerson && Object.keys(perPerson).length > 0) {
      for (const [userId, cents] of Object.entries(perPerson)) {
        if (owed.has(userId)) owed.set(userId, owed.get(userId) + cents);
      }
    } else {
      // Legacy: split equally across all members.
      const base = Math.floor(amountCents / members.length);
      let remainder = amountCents - base * members.length;
      for (const m of members) {
        owed.set(m.id, owed.get(m.id) + base + (remainder > 0 ? 1 : 0));
        if (remainder > 0) remainder -= 1;
      }
    }
  }

  const perPerson = members.map((m) => {
    const paidCents = paid.get(m.id);
    const owedCents = owed.get(m.id);
    return {
      userId: m.id,
      name: m.name,
      avatarUrl: m.avatarUrl || m.image || null,
      paid: toAmount(paidCents),
      owed: toAmount(owedCents),
      balance: toAmount(paidCents - owedCents), // + is owed money, - owes money
    };
  });

  // Greedy settlement: largest debtor pays the largest creditor.
  const creditors = perPerson
    .filter((p) => p.balance > 0)
    .map((p) => ({ ...p, net: toCents(p.balance) }))
    .sort((a, b) => b.net - a.net);
  const debtors = perPerson
    .filter((p) => p.balance < 0)
    .map((p) => ({ ...p, net: -toCents(p.balance) }))
    .sort((a, b) => b.net - a.net);

  const settlements = [];
  let i = 0;
  let j = 0;
  while (i < creditors.length && j < debtors.length) {
    const c = creditors[i];
    const d = debtors[j];
    const amountCents = Math.min(c.net, d.net);
    if (amountCents > 0) {
      settlements.push({
        from: d.userId,
        fromName: d.name,
        to: c.userId,
        toName: c.name,
        amount: toAmount(amountCents),
      });
    }
    c.net -= amountCents;
    d.net -= amountCents;
    if (c.net === 0) i += 1;
    if (d.net === 0) j += 1;
  }

  return {
    total: toAmount(totalCents),
    memberCount: members.length,
    perPerson,
    settlements,
    categories: [...categoryTotals.entries()]
      .map(([category, cents]) => ({ category, total: toAmount(cents) }))
      .sort((a, b) => b.total - a.total),
  };
}

// GET /api/expenses/:groupId/balance  -> per-person balances + who owes whom + categories
router.get('/:groupId/balance', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) return res.status(403).json({ error: 'You are not a member of this group' });

    const balance = await buildBalance(groupId);
    if (!balance) return res.json({ total: 0, perPerson: [], settlements: [], categories: [] });
    res.json(balance);
  } catch (err) {
    console.error('Balance error:', err);
    res.status(500).json({ error: 'Failed to calculate balances' });
  }
});

// GET /api/expenses/summary/:groupId  -> alias of balance (kept for compatibility)
router.get('/summary/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) return res.status(403).json({ error: 'You are not a member of this group' });

    const balance = await buildBalance(groupId);
    if (!balance) return res.json({ total: 0, members: [], categories: [] });

    res.json({
      total: balance.total,
      categories: balance.categories,
      members: balance.perPerson.map((p) => ({
        userId: p.userId,
        name: p.name,
        spent: p.paid,
        share: p.owed,
        owes: toAmount(Math.max(0, -toCents(p.balance))),
        receivable: toAmount(Math.max(0, toCents(p.balance))),
      })),
    });
  } catch (err) {
    console.error('Expense summary error:', err);
    res.status(500).json({ error: 'Failed to calculate summary' });
  }
});

module.exports = router;
