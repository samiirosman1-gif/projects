const express = require('express');
const pool    = require('../db');
const gl = require('../gl');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// ── GET /api/invoices ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let q = `
      SELECT i.invoice_id, i.invoice_number, i.status,
             i.issue_date, i.due_date,
             i.subtotal, i.tax_amount, i.discount_amount,
             i.total_amount, i.amount_paid,
             (i.total_amount - i.amount_paid) AS balance_due,
             i.notes, i.terms, i.created_at,
             c.full_name AS customer_name,
             c.email     AS customer_email,
             c.phone     AS customer_phone,
             u.full_name AS created_by_name,
             CASE
               WHEN i.status != 'paid' AND i.status != 'void'
                    AND i.due_date < CURRENT_DATE THEN 'overdue'
               ELSE i.status
             END AS effective_status
      FROM invoices i
      LEFT JOIN customers c ON c.customer_id = i.customer_id
      LEFT JOIN users u     ON u.user_id     = i.created_by
      WHERE 1=1
    `;
    const p = [];
    if (status && status !== 'all') {
      p.push(status);
      q += ` AND i.status = $${p.length}`;
    }
    q += ' ORDER BY i.created_at DESC';
    const r = await pool.query(q, p);
    res.json({ invoices: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/invoices/summary ─────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('paid','void'))::int AS open_count,
        COALESCE(SUM(total_amount - amount_paid)
          FILTER (WHERE status NOT IN ('paid','void')), 0) AS total_outstanding,
        COALESCE(SUM(total_amount - amount_paid)
          FILTER (WHERE status NOT IN ('paid','void')
            AND due_date < CURRENT_DATE), 0) AS total_overdue,
        COALESCE(SUM(total_amount - amount_paid)
          FILTER (WHERE status NOT IN ('paid','void')
            AND due_date >= CURRENT_DATE
            AND due_date < CURRENT_DATE + 30), 0) AS due_30_days
      FROM invoices`);
    res.json({ summary: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/invoices/:id ─────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const inv = await pool.query(`
      SELECT i.*,
             (i.total_amount - i.amount_paid) AS balance_due,
             c.full_name AS customer_name, c.email AS customer_email,
             c.phone AS customer_phone, c.address AS customer_address,
             c.loyalty_points, c.total_spent,
             u.full_name AS created_by_name,
             CASE
               WHEN i.status != 'paid' AND i.status != 'void'
                    AND i.due_date < CURRENT_DATE THEN 'overdue'
               ELSE i.status
             END AS effective_status
      FROM invoices i
      LEFT JOIN customers c ON c.customer_id = i.customer_id
      LEFT JOIN users u     ON u.user_id     = i.created_by
      WHERE i.invoice_id = $1`, [req.params.id]);

    if (!inv.rows.length) return res.status(404).json({ error: 'Invoice not found.' });

    const items = await pool.query(
      `SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY item_id`,
      [req.params.id]);

    // Customer outstanding balance
    const outstanding = await pool.query(`
      SELECT COALESCE(SUM(total_amount - amount_paid), 0) AS outstanding
      FROM invoices
      WHERE customer_id = $1 AND status NOT IN ('paid','void')
        AND invoice_id != $2`,
      [inv.rows[0].customer_id, req.params.id]);

    res.json({
      invoice: inv.rows[0],
      items: items.rows,
      customer_outstanding: outstanding.rows[0]?.outstanding ?? 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/invoices/customer/:customerId ────────────────────────────────
// Get all invoices + outstanding for a customer (used when creating new invoice)
router.get('/customer/:customerId', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT invoice_id, invoice_number, status, issue_date, due_date,
             total_amount, amount_paid,
             (total_amount - amount_paid) AS balance_due
      FROM invoices
      WHERE customer_id = $1
      ORDER BY created_at DESC LIMIT 10`, [req.params.customerId]);

    const outstanding = await pool.query(`
      SELECT COALESCE(SUM(total_amount - amount_paid), 0) AS outstanding
      FROM invoices
      WHERE customer_id = $1 AND status NOT IN ('paid','void')`,
      [req.params.customerId]);

    res.json({
      invoices: r.rows,
      outstanding: outstanding.rows[0]?.outstanding ?? 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/invoices ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    customer_id, sale_id, issue_date, due_date,
    items = [], tax_rate = 0, discount_amount = 0,
    notes, terms,
  } = req.body;

  if (!customer_id) return res.status(400).json({ error: 'customer_id is required.' });
  if (!items.length) return res.status(400).json({ error: 'At least one item is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    const discount = parseFloat(discount_amount) || 0;
    const taxAmt   = (subtotal - discount) * (parseFloat(tax_rate) / 100);
    const total    = subtotal - discount + taxAmt;

    const inv = await client.query(`
      INSERT INTO invoices
        (customer_id, sale_id, issue_date, due_date,
         subtotal, tax_amount, discount_amount, total_amount,
         notes, terms, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [customer_id, sale_id||null,
       issue_date || new Date().toISOString().split('T')[0],
       due_date||null, subtotal, taxAmt, discount, total,
       notes||null,
       terms || 'Payment due within 30 days.',
       req.user.userId]);

    for (const item of items) {
      const sub = item.quantity * item.unit_price;
      await client.query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5)`,
        [inv.rows[0].invoice_id, item.description, item.quantity, item.unit_price, sub]);
    }

    // ── Post to general ledger: customer now owes us (A/R) ──
    await gl.postEntry(client, {
      date: inv.rows[0].issue_date,
      memo: `Invoice ${inv.rows[0].invoice_number}`,
      sourceType: 'invoice', sourceId: inv.rows[0].invoice_id, createdBy: req.user.userId,
      lines: [
        { systemKey: 'ar',           debit: total,    description: 'Accounts receivable' },
        { systemKey: 'sales_income', credit: subtotal, description: 'Sales revenue' },
        { systemKey: 'sales_tax',    credit: taxAmt,   description: 'Sales tax' },
        { systemKey: 'discounts',    debit: discount,  description: 'Discount given' },
      ],
    });

    await client.query('COMMIT');
    res.status(201).json({
      invoice_id: inv.rows[0].invoice_id,
      invoice_number: inv.rows[0].invoice_number,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── PATCH /api/invoices/:id ───────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const { status, amount_paid, notes, due_date } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT * FROM invoices WHERE invoice_id=$1', [req.params.id]);
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found.' });
    }
    const old = cur.rows[0];

    let finalStatus = status;
    if (amount_paid !== undefined && !status) {
      const total = parseFloat(old.total_amount);
      const paid  = parseFloat(amount_paid);
      finalStatus = paid >= total ? 'paid' : paid > 0 ? 'partial' : old.status;
    }
    const r = await client.query(`
      UPDATE invoices SET
        status      = COALESCE($1, status),
        amount_paid = COALESCE($2, amount_paid),
        notes       = COALESCE($3, notes),
        due_date    = COALESCE($4, due_date),
        updated_at  = NOW()
      WHERE invoice_id=$5 RETURNING *`,
      [finalStatus, amount_paid??null, notes??null, due_date??null, req.params.id]);

    // ── Post incremental customer payment: cash in, A/R down ──
    if (amount_paid !== undefined) {
      const increment = gl.round2(parseFloat(amount_paid) - parseFloat(old.amount_paid));
      if (increment > 0) {
        await gl.postEntry(client, {
          memo: `Payment received — ${old.invoice_number}`,
          sourceType: 'invoice_payment', sourceId: Number(req.params.id),
          createdBy: req.user.userId,
          lines: [
            { systemKey: 'bank', debit: increment,  description: 'Customer payment' },
            { systemKey: 'ar',   credit: increment, description: 'A/R settled' },
          ],
        });
      }
    }
    await client.query('COMMIT');
    res.json({ invoice: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── DELETE /api/invoices/:id (draft only) ────────────────────────────────
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `DELETE FROM invoices WHERE invoice_id=$1 AND status='draft' RETURNING invoice_id`,
      [req.params.id]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft invoices can be deleted.' });
    }
    await gl.reverseEntries(client, 'invoice', Number(req.params.id));
    await gl.reverseEntries(client, 'invoice_payment', Number(req.params.id));
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;