const express = require('express');
const pool    = require('../db');
const gl = require('../gl');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// ── GET /api/bills ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let q = `
      SELECT b.bill_id, b.bill_number, b.status, b.supplier_ref,
             b.issue_date, b.due_date,
             b.subtotal, b.tax_amount, b.total_amount, b.amount_paid,
             (b.total_amount - b.amount_paid) AS balance_due,
             b.notes, b.created_at,
             s.name        AS supplier_name,
             s.email       AS supplier_email,
             s.phone       AS supplier_phone,
             po.po_id,
             u.full_name   AS created_by_name,
             CASE
               WHEN b.status NOT IN ('paid','void')
                    AND b.due_date < CURRENT_DATE THEN 'overdue'
               ELSE b.status
             END AS effective_status
      FROM bills b
      LEFT JOIN suppliers s ON s.supplier_id = b.supplier_id
      LEFT JOIN purchase_orders po ON po.po_id = b.po_id
      LEFT JOIN users u ON u.user_id = b.created_by
      WHERE 1=1
    `;
    const p = [];
    if (status && status !== 'all') {
      p.push(status);
      q += ` AND b.status = $${p.length}`;
    }
    q += ' ORDER BY b.created_at DESC';
    const r = await pool.query(q, p);
    res.json({ bills: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/bills/summary ────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('paid','void'))::int AS open_count,
        COALESCE(SUM(total_amount - amount_paid)
          FILTER (WHERE status NOT IN ('paid','void')), 0) AS total_owed,
        COALESCE(SUM(total_amount - amount_paid)
          FILTER (WHERE status NOT IN ('paid','void')
            AND due_date < CURRENT_DATE), 0) AS total_overdue,
        COALESCE(SUM(total_amount - amount_paid)
          FILTER (WHERE status NOT IN ('paid','void')
            AND due_date >= CURRENT_DATE
            AND due_date < CURRENT_DATE + 30), 0) AS due_30_days
      FROM bills`);
    res.json({ summary: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/bills/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const bill = await pool.query(`
      SELECT b.*,
             (b.total_amount - b.amount_paid) AS balance_due,
             s.name AS supplier_name, s.email AS supplier_email,
             s.phone AS supplier_phone, s.address AS supplier_address,
             po.po_id,
             u.full_name AS created_by_name,
             CASE
               WHEN b.status NOT IN ('paid','void')
                    AND b.due_date < CURRENT_DATE THEN 'overdue'
               ELSE b.status
             END AS effective_status
      FROM bills b
      LEFT JOIN suppliers s ON s.supplier_id = b.supplier_id
      LEFT JOIN purchase_orders po ON po.po_id = b.po_id
      LEFT JOIN users u ON u.user_id = b.created_by
      WHERE b.bill_id = $1`, [req.params.id]);

    if (!bill.rows.length) return res.status(404).json({ error: 'Bill not found.' });

    const items = await pool.query(
      `SELECT * FROM invoice_items WHERE bill_id=$1 ORDER BY item_id`,
      [req.params.id]);

    // Supplier total owed across all unpaid bills
    const supplierOwed = await pool.query(`
      SELECT COALESCE(SUM(total_amount - amount_paid), 0) AS total_owed
      FROM bills
      WHERE supplier_id = $1 AND status NOT IN ('paid','void')
        AND bill_id != $2`,
      [bill.rows[0].supplier_id, req.params.id]);

    res.json({
      bill: bill.rows[0],
      items: items.rows,
      supplier_total_owed: supplierOwed.rows[0]?.total_owed ?? 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/bills/supplier/:supplierId ───────────────────────────────────
router.get('/supplier/:supplierId', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT bill_id, bill_number, status, issue_date, due_date,
             total_amount, amount_paid,
             (total_amount - amount_paid) AS balance_due,
             supplier_ref
      FROM bills
      WHERE supplier_id = $1
      ORDER BY created_at DESC LIMIT 10`, [req.params.supplierId]);

    const owed = await pool.query(`
      SELECT COALESCE(SUM(total_amount - amount_paid), 0) AS total_owed
      FROM bills
      WHERE supplier_id = $1 AND status NOT IN ('paid','void')`,
      [req.params.supplierId]);

    // Uninvoiced received POs
    const uninvoicedPOs = await pool.query(`
      SELECT po.po_id,
             COALESCE(SUM(poi.quantity * poi.unit_cost), 0) AS total_cost,
             COUNT(poi.po_item_id)::int AS item_count,
             po.created_at
      FROM purchase_orders po
      LEFT JOIN purchase_order_items poi ON poi.po_id = po.po_id
      LEFT JOIN bills b ON b.po_id = po.po_id
      WHERE po.supplier_id = $1
        AND po.status = 'received'
        AND b.bill_id IS NULL
      GROUP BY po.po_id
      ORDER BY po.created_at DESC`,
      [req.params.supplierId]);

    res.json({
      bills: r.rows,
      total_owed: owed.rows[0]?.total_owed ?? 0,
      uninvoiced_pos: uninvoicedPOs.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/bills ───────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    supplier_id, po_id, supplier_ref,
    issue_date, due_date,
    items = [], tax_rate = 0, notes,
  } = req.body;

  if (!supplier_id) return res.status(400).json({ error: 'supplier_id is required.' });
  if (!items.length) return res.status(400).json({ error: 'At least one item is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    const taxAmt   = subtotal * (parseFloat(tax_rate) / 100);
    const total    = subtotal + taxAmt;

    const bill = await client.query(`
      INSERT INTO bills
        (supplier_id, po_id, supplier_ref, issue_date, due_date,
         subtotal, tax_amount, total_amount, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [supplier_id, po_id||null, supplier_ref||null,
       issue_date || new Date().toISOString().split('T')[0],
       due_date||null, subtotal, taxAmt, total,
       notes||null, req.user.userId]);

    for (const item of items) {
      const sub = item.quantity * item.unit_price;
      await client.query(
        `INSERT INTO invoice_items (bill_id, description, quantity, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5)`,
        [bill.rows[0].bill_id, item.description, item.quantity, item.unit_price, sub]);
    }

    // ── Post to general ledger: we now owe the supplier (A/P) ──
    // PO-linked bills land in Inventory Asset (goods received); manual bills
    // default to the Supplies expense account (reclassify via journal entry).
    await gl.postEntry(client, {
      date: bill.rows[0].issue_date,
      memo: `Bill ${bill.rows[0].bill_number}`,
      sourceType: 'bill', sourceId: bill.rows[0].bill_id, createdBy: req.user.userId,
      lines: [
        { systemKey: po_id ? 'inventory' : 'expense_supplies', debit: total,
          description: po_id ? 'Inventory received' : 'Bill expense' },
        { systemKey: 'ap', credit: total, description: 'Accounts payable' },
      ],
    });

    await client.query('COMMIT');
    res.status(201).json({
      bill_id: bill.rows[0].bill_id,
      bill_number: bill.rows[0].bill_number,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── POST /api/bills/from-po/:poId ─────────────────────────────────────────
router.post('/from-po/:poId', async (req, res) => {
  const { due_date, supplier_ref } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check not already billed
    const existing = await client.query(
      'SELECT bill_id FROM bills WHERE po_id=$1', [req.params.poId]);
    if (existing.rows.length)
      return res.status(409).json({ error: 'A bill already exists for this PO.' });

    const po = await client.query(`
      SELECT po.*, s.supplier_id
      FROM purchase_orders po
      JOIN suppliers s ON s.supplier_id = po.supplier_id
      WHERE po.po_id=$1`, [req.params.poId]);
    if (!po.rows.length) return res.status(404).json({ error: 'PO not found.' });

    const items = await client.query(
      `SELECT description, quantity, unit_cost FROM purchase_order_items WHERE po_id=$1`,
      [req.params.poId]);

    const subtotal = items.rows.reduce((s, i) => s + i.quantity * i.unit_cost, 0);

    const bill = await client.query(`
      INSERT INTO bills
        (supplier_id, po_id, supplier_ref, issue_date, due_date,
         subtotal, total_amount, notes, created_by)
      VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$5,$6,$7)
      RETURNING *`,
      [po.rows[0].supplier_id, req.params.poId,
       supplier_ref||null,
       due_date||null,
       subtotal,
       `Bill for PO-${String(req.params.poId).padStart(4,'0')}`,
       req.user.userId]);

    for (const item of items.rows) {
      const sub = item.quantity * item.unit_cost;
      await client.query(
        `INSERT INTO invoice_items (bill_id, description, quantity, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5)`,
        [bill.rows[0].bill_id, item.description, item.quantity, item.unit_cost, sub]);
    }

    // ── Post to general ledger: goods received into Inventory, owed via A/P ──
    await gl.postEntry(client, {
      memo: `Bill ${bill.rows[0].bill_number} (from PO-${String(req.params.poId).padStart(4,'0')})`,
      sourceType: 'bill', sourceId: bill.rows[0].bill_id, createdBy: req.user.userId,
      lines: [
        { systemKey: 'inventory', debit: subtotal, description: 'Inventory received from PO' },
        { systemKey: 'ap',        credit: subtotal, description: 'Accounts payable' },
      ],
    });

    await client.query('COMMIT');
    res.status(201).json({
      bill_id: bill.rows[0].bill_id,
      bill_number: bill.rows[0].bill_number,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── PATCH /api/bills/:id ──────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const { status, amount_paid, notes, due_date, supplier_ref } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT * FROM bills WHERE bill_id=$1', [req.params.id]);
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found.' });
    }
    const old = cur.rows[0];

    let finalStatus = status;
    if (amount_paid !== undefined && !status) {
      const total = parseFloat(old.total_amount);
      const paid  = parseFloat(amount_paid);
      finalStatus = paid >= total ? 'paid' : paid > 0 ? 'partial' : undefined;
    }
    const r = await client.query(`
      UPDATE bills SET
        status       = COALESCE($1, status),
        amount_paid  = COALESCE($2, amount_paid),
        notes        = COALESCE($3, notes),
        due_date     = COALESCE($4, due_date),
        supplier_ref = COALESCE($5, supplier_ref),
        updated_at   = NOW()
      WHERE bill_id=$6 RETURNING *`,
      [finalStatus, amount_paid??null, notes??null,
       due_date??null, supplier_ref??null, req.params.id]);

    // ── Post incremental supplier payment: A/P down, cash/bank out ──
    if (amount_paid !== undefined) {
      const increment = gl.round2(parseFloat(amount_paid) - parseFloat(old.amount_paid));
      if (increment > 0) {
        await gl.postEntry(client, {
          memo: `Payment made — ${old.bill_number}`,
          sourceType: 'bill_payment', sourceId: Number(req.params.id),
          createdBy: req.user.userId,
          lines: [
            { systemKey: 'ap',   debit: increment,  description: 'A/P settled' },
            { systemKey: 'bank', credit: increment, description: 'Supplier payment' },
          ],
        });
      }
    }
    await client.query('COMMIT');
    res.json({ bill: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── DELETE /api/bills/:id (draft only) ───────────────────────────────────
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `DELETE FROM bills WHERE bill_id=$1 AND status='draft' RETURNING bill_id`,
      [req.params.id]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft bills can be deleted.' });
    }
    await gl.reverseEntries(client, 'bill', Number(req.params.id));
    await gl.reverseEntries(client, 'bill_payment', Number(req.params.id));
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;