const express = require('express');
const pool = require('../db');
const gl = require('../gl');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// GET /api/sales — list with filters
router.get('/', async (req, res) => {
  try {
    const { from, to, payment_method, limit = 100 } = req.query;
    let query = `
      SELECT s.sale_id, s.subtotal, s.tax_amount, s.discount_amount,
             s.total_amount, s.payment_method, s.notes, s.created_at,
             c.full_name AS customer_name,
             u.full_name AS cashier_name,
             COUNT(si.sale_item_id) AS item_count
      FROM sales s
      LEFT JOIN customers c ON c.customer_id = s.customer_id
      LEFT JOIN users u ON u.user_id = s.created_by
      LEFT JOIN sale_items si ON si.sale_id = s.sale_id
      WHERE 1=1
    `;
    const params = [];

    if (from) {
      params.push(from);
      query += ` AND s.created_at >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      query += ` AND s.created_at <= $${params.length}`;
    }
    if (payment_method) {
      params.push(payment_method);
      query += ` AND s.payment_method = $${params.length}`;
    }

    query += ` GROUP BY s.sale_id, c.full_name, u.full_name
               ORDER BY s.created_at DESC
               LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json({ sales: result.rows });
  } catch (err) {
    console.error('List sales error:', err);
    res.status(500).json({ error: 'Could not load sales.' });
  }
});

// GET /api/sales/summary — daily stats
router.get('/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const toDate   = to   || new Date().toISOString();

    const summaryResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_transactions,
         COALESCE(SUM(total_amount), 0) AS total_revenue,
         COALESCE(AVG(total_amount), 0) AS avg_order_value,
         COALESCE(SUM(tax_amount), 0) AS total_tax,
         COALESCE(SUM(discount_amount), 0) AS total_discounts
       FROM sales
       WHERE created_at >= $1 AND created_at <= $2`,
      [fromDate, toDate]
    );

    const byPaymentResult = await pool.query(
      `SELECT payment_method,
              COUNT(*)::int AS count,
              COALESCE(SUM(total_amount), 0) AS total
       FROM sales
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY payment_method
       ORDER BY total DESC`,
      [fromDate, toDate]
    );

    const dailyResult = await pool.query(
      `SELECT DATE(created_at) AS date,
              COUNT(*)::int AS transactions,
              COALESCE(SUM(total_amount), 0) AS revenue
       FROM sales
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [fromDate, toDate]
    );

    const topItemsResult = await pool.query(
      `SELECT si.description,
              SUM(si.quantity)::numeric AS total_qty,
              SUM(si.subtotal)::numeric AS total_revenue
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.created_at >= $1 AND s.created_at <= $2
       GROUP BY si.description
       ORDER BY total_revenue DESC
       LIMIT 5`,
      [fromDate, toDate]
    );

    res.json({
      summary: summaryResult.rows[0],
      by_payment: byPaymentResult.rows,
      daily: dailyResult.rows,
      top_items: topItemsResult.rows,
    });
  } catch (err) {
    console.error('Sales summary error:', err);
    res.status(500).json({ error: 'Could not load summary.' });
  }
});

// GET /api/sales/:id — single sale with items
router.get('/:id', async (req, res) => {
  try {
    const saleResult = await pool.query(
      `SELECT s.sale_id, s.subtotal, s.tax_amount, s.discount_amount,
              s.total_amount, s.payment_method, s.notes, s.created_at,
              c.full_name AS customer_name, c.customer_id,
              u.full_name AS cashier_name
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN users u ON u.user_id = s.created_by
       WHERE s.sale_id = $1`,
      [req.params.id]
    );
    if (saleResult.rows.length === 0)
      return res.status(404).json({ error: 'Sale not found.' });

    const itemsResult = await pool.query(
      `SELECT sale_item_id, description, quantity, unit_price, subtotal
       FROM sale_items WHERE sale_id = $1 ORDER BY sale_item_id`,
      [req.params.id]
    );

    res.json({ sale: saleResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    console.error('Get sale error:', err);
    res.status(500).json({ error: 'Could not load sale.' });
  }
});

// POST /api/sales — create a new sale (used by POS)
router.post('/', async (req, res) => {
  const { customer_id, items, payment_method, discount_amount, notes } = req.body;
  if (!items || items.length === 0)
    return res.status(400).json({ error: 'At least one item is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    const discount = discount_amount || 0;

    // Get tax rate from settings (we'll use 0 for now, POS will pass it)
    const taxRate   = req.body.tax_rate || 0;
    const taxAmount = (subtotal - discount) * (taxRate / 100);
    const total     = subtotal - discount + taxAmount;

    const saleResult = await client.query(
      `INSERT INTO sales
         (customer_id, subtotal, tax_amount, discount_amount, total_amount,
          payment_method, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING sale_id`,
      [customer_id || null, subtotal, taxAmount, discount, total,
       payment_method || 'cash', notes || null, req.user.userId]
    );
    const saleId = saleResult.rows[0].sale_id;

    for (const item of items) {
      const itemSubtotal = item.quantity * item.unit_price;
      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, description, quantity, unit_price, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [saleId, item.product_id || null, item.description,
         item.quantity, item.unit_price, itemSubtotal]
      );
    }

    // Update customer stats if linked
    if (customer_id) {
      const points = Math.floor(total);
      await client.query(
        `UPDATE customers
         SET total_spent = total_spent + $1,
             visit_count = visit_count + 1,
             loyalty_points = loyalty_points + $2,
             updated_at = NOW()
         WHERE customer_id = $3`,
        [total, points, customer_id]
      );
    }

    // ── Post to general ledger (double-entry) ──
    await gl.postEntry(client, {
      memo: `POS Sale #${saleId}`, sourceType: 'sale', sourceId: saleId,
      createdBy: req.user.userId,
      lines: [
        { systemKey: gl.paymentAccountKey(payment_method), debit: total, description: 'Sale received' },
        { systemKey: 'sales_income', credit: subtotal,  description: 'Sales revenue' },
        { systemKey: 'sales_tax',    credit: taxAmount, description: 'Sales tax collected' },
        { systemKey: 'discounts',    debit: discount,   description: 'Discount given' },
        ...(await gl.cogsLinesForSale(client, saleId)),
      ],
    });

    await client.query('COMMIT');
    res.status(201).json({ sale_id: saleId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create sale error:', err);
    res.status(500).json({ error: 'Could not create sale.' });
  } finally {
    client.release();
  }
});

module.exports = router;