const express = require('express');
const pool    = require('../db');
const gl = require('../gl');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Default expense categories surfaced in the UI even before any are used
const DEFAULT_CATEGORIES = [
  'Rent', 'Utilities', 'Supplies', 'Payroll', 'Marketing',
  'Maintenance', 'Transport', 'Insurance', 'Equipment', 'Other',
];

// ── GET /api/expenses ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { category, search, from, to } = req.query;
    let q = `
      SELECT e.expense_id, e.expense_number, e.category, e.payee,
             e.supplier_id, e.payment_method, e.expense_date,
             e.amount, e.tax_amount, e.total_amount,
             e.reference, e.notes, e.status, e.created_at,
             s.name      AS supplier_name,
             u.full_name AS created_by_name
      FROM expenses e
      LEFT JOIN suppliers s ON s.supplier_id = e.supplier_id
      LEFT JOIN users u ON u.user_id = e.created_by
      WHERE 1=1
    `;
    const p = [];
    if (category && category !== 'all') {
      p.push(category);
      q += ` AND e.category = $${p.length}`;
    }
    if (search) {
      p.push(`%${search}%`);
      q += ` AND (e.payee ILIKE $${p.length} OR e.expense_number ILIKE $${p.length}
                  OR e.reference ILIKE $${p.length} OR e.notes ILIKE $${p.length})`;
    }
    if (from) { p.push(from); q += ` AND e.expense_date >= $${p.length}`; }
    if (to)   { p.push(to);   q += ` AND e.expense_date <= $${p.length}`; }
    q += ' ORDER BY e.expense_date DESC, e.expense_id DESC';
    const r = await pool.query(q, p);
    res.json({ expenses: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/expenses/summary ───────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const totals = await pool.query(`
      SELECT
        COALESCE(SUM(total_amount) FILTER (
          WHERE date_trunc('month', expense_date) = date_trunc('month', CURRENT_DATE)
        ), 0) AS this_month,
        COUNT(*) FILTER (
          WHERE date_trunc('month', expense_date) = date_trunc('month', CURRENT_DATE)
        )::int AS this_month_count,
        COALESCE(SUM(total_amount) FILTER (
          WHERE date_trunc('year', expense_date) = date_trunc('year', CURRENT_DATE)
        ), 0) AS this_year
      FROM expenses`);

    const top = await pool.query(`
      SELECT category, COALESCE(SUM(total_amount), 0) AS spent
      FROM expenses
      WHERE date_trunc('month', expense_date) = date_trunc('month', CURRENT_DATE)
      GROUP BY category
      ORDER BY spent DESC
      LIMIT 1`);

    // Per-category breakdown for the current month (drives the chips/legend)
    const byCategory = await pool.query(`
      SELECT category, COALESCE(SUM(total_amount), 0) AS spent, COUNT(*)::int AS count
      FROM expenses
      WHERE date_trunc('month', expense_date) = date_trunc('month', CURRENT_DATE)
      GROUP BY category
      ORDER BY spent DESC`);

    res.json({
      summary: {
        ...totals.rows[0],
        top_category:        top.rows[0]?.category ?? null,
        top_category_amount: top.rows[0]?.spent ?? 0,
      },
      by_category: byCategory.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/expenses/categories ────────────────────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT category FROM expenses WHERE category IS NOT NULL`);
    const used = r.rows.map((x) => x.category);
    const all = [...new Set([...DEFAULT_CATEGORIES, ...used])];
    res.json({ categories: all });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/expenses/:id ───────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*,
             s.name AS supplier_name, s.email AS supplier_email,
             s.phone AS supplier_phone,
             u.full_name AS created_by_name
      FROM expenses e
      LEFT JOIN suppliers s ON s.supplier_id = e.supplier_id
      LEFT JOIN users u ON u.user_id = e.created_by
      WHERE e.expense_id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Expense not found.' });
    res.json({ expense: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/expenses ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    category, payee, supplier_id, payment_method,
    expense_date, amount, tax_rate = 0, reference, notes, status,
  } = req.body;

  if (!category)       return res.status(400).json({ error: 'category is required.' });
  if (amount == null)  return res.status(400).json({ error: 'amount is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sub    = parseFloat(amount) || 0;
    const taxAmt = sub * (parseFloat(tax_rate) / 100);
    const total  = sub + taxAmt;
    const method = payment_method || 'cash';

    const r = await client.query(`
      INSERT INTO expenses
        (category, payee, supplier_id, payment_method, expense_date,
         amount, tax_amount, total_amount, reference, notes, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING expense_id, expense_number`,
      [category, payee || null, supplier_id || null,
       method,
       expense_date || new Date().toISOString().split('T')[0],
       sub, taxAmt, total,
       reference || null, notes || null, status || 'paid',
       req.user.userId]);

    // ── Post to general ledger: expense up, cash/bank/card down ──
    await gl.postEntry(client, {
      date: expense_date || undefined,
      memo: `Expense ${r.rows[0].expense_number} — ${category}`,
      sourceType: 'expense', sourceId: r.rows[0].expense_id, createdBy: req.user.userId,
      lines: [
        { expenseCategory: category, debit: total, description: payee || category },
        { systemKey: gl.paymentAccountKey(method), credit: total, description: 'Paid' },
      ],
    });

    await client.query('COMMIT');
    res.status(201).json({
      expense_id:     r.rows[0].expense_id,
      expense_number: r.rows[0].expense_number,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── PATCH /api/expenses/:id ─────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const {
    category, payee, supplier_id, payment_method, expense_date,
    amount, tax_rate, reference, notes, status,
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT * FROM expenses WHERE expense_id=$1', [req.params.id]);
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found.' });
    }

    let amountVal = null, taxVal = null, totalVal = null;
    if (amount !== undefined) {
      const sub  = parseFloat(amount) || 0;
      const rate = tax_rate !== undefined ? parseFloat(tax_rate) / 100 : null;
      amountVal  = sub;
      if (rate !== null) { taxVal = sub * rate; totalVal = sub + taxVal; }
    }

    const r = await client.query(`
      UPDATE expenses SET
        category       = COALESCE($1, category),
        payee          = COALESCE($2, payee),
        supplier_id    = COALESCE($3, supplier_id),
        payment_method = COALESCE($4, payment_method),
        expense_date   = COALESCE($5, expense_date),
        amount         = COALESCE($6, amount),
        tax_amount     = COALESCE($7, tax_amount),
        total_amount   = COALESCE($8, total_amount),
        reference      = COALESCE($9, reference),
        notes          = COALESCE($10, notes),
        status         = COALESCE($11, status),
        updated_at     = NOW()
      WHERE expense_id = $12 RETURNING *`,
      [category ?? null, payee ?? null, supplier_id ?? null,
       payment_method ?? null, expense_date ?? null,
       amountVal, taxVal, totalVal,
       reference ?? null, notes ?? null, status ?? null,
       req.params.id]);

    const updated = r.rows[0];
    await gl.reverseEntries(client, 'expense', Number(req.params.id));
    await gl.postEntry(client, {
      date: updated.expense_date,
      memo: `Expense ${updated.expense_number} — ${updated.category}`,
      sourceType: 'expense', sourceId: updated.expense_id, createdBy: req.user.userId,
      lines: [
        { expenseCategory: updated.category, debit: parseFloat(updated.total_amount), description: updated.payee || updated.category },
        { systemKey: gl.paymentAccountKey(updated.payment_method), credit: parseFloat(updated.total_amount), description: 'Paid' },
      ],
    });

    await client.query('COMMIT');
    res.json({ expense: updated });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── DELETE /api/expenses/:id ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query(
      'SELECT expense_id FROM expenses WHERE expense_id=$1', [req.params.id]);
    if (!check.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found.' });
    }
    await gl.reverseEntries(client, 'expense', Number(req.params.id));
    await client.query('DELETE FROM expenses WHERE expense_id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
