const express = require('express');
const pool = require('../db');
const { verifyToken, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken, requirePermission('manage_suppliers'));

const VALID_STATUSES = ['draft', 'sent', 'received', 'cancelled'];

// GET /api/purchase-orders
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT po.po_id, po.status, po.notes, po.created_at, po.updated_at,
              s.name AS supplier_name, s.supplier_id,
              u.full_name AS created_by_name,
              COALESCE(SUM(poi.quantity * poi.unit_cost), 0) AS total_cost,
              COUNT(poi.po_item_id) AS item_count
       FROM purchase_orders po
       JOIN suppliers s ON s.supplier_id = po.supplier_id
       LEFT JOIN users u ON u.user_id = po.created_by
       LEFT JOIN purchase_order_items poi ON poi.po_id = po.po_id
       GROUP BY po.po_id, s.name, s.supplier_id, u.full_name
       ORDER BY po.created_at DESC`
    );
    res.json({ purchase_orders: result.rows });
  } catch (err) {
    console.error('List POs error:', err);
    res.status(500).json({ error: 'Could not load purchase orders.' });
  }
});

// GET /api/purchase-orders/:id
router.get('/:id', async (req, res) => {
  try {
    const poResult = await pool.query(
      `SELECT po.po_id, po.status, po.notes, po.created_at, po.updated_at,
              s.name AS supplier_name, s.supplier_id, s.email AS supplier_email,
              s.phone AS supplier_phone, u.full_name AS created_by_name
       FROM purchase_orders po
       JOIN suppliers s ON s.supplier_id = po.supplier_id
       LEFT JOIN users u ON u.user_id = po.created_by
       WHERE po.po_id = $1`,
      [req.params.id]
    );
    if (poResult.rows.length === 0)
      return res.status(404).json({ error: 'Purchase order not found.' });

    const itemsResult = await pool.query(
      `SELECT poi.po_item_id, poi.description, poi.quantity,
              poi.unit_cost, poi.received_quantity,
              ii.item_id AS inventory_item_id, ii.name AS inventory_item_name, ii.unit
       FROM purchase_order_items poi
       LEFT JOIN inventory_items ii ON ii.item_id = poi.inventory_item_id
       WHERE poi.po_id = $1
       ORDER BY poi.po_item_id`,
      [req.params.id]
    );

    res.json({ purchase_order: poResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    console.error('Get PO error:', err);
    res.status(500).json({ error: 'Could not load purchase order.' });
  }
});

// POST /api/purchase-orders
router.post('/', async (req, res) => {
  const { supplier_id, notes, items } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'supplier_id is required.' });
  if (!items || items.length === 0)
    return res.status(400).json({ error: 'At least one item is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const poResult = await client.query(
      `INSERT INTO purchase_orders (supplier_id, notes, created_by)
       VALUES ($1,$2,$3) RETURNING po_id`,
      [supplier_id, notes||null, req.user.userId]
    );
    const poId = poResult.rows[0].po_id;

    for (const item of items) {
      await client.query(
        `INSERT INTO purchase_order_items
         (po_id, inventory_item_id, description, quantity, unit_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [poId, item.inventory_item_id||null,
         item.description, item.quantity, item.unit_cost]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ po_id: poId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create PO error:', err);
    res.status(500).json({ error: 'Could not create purchase order.' });
  } finally {
    client.release();
  }
});

// PATCH /api/purchase-orders/:id/status
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status))
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });

  try {
    const result = await pool.query(
      `UPDATE purchase_orders SET status=$1, updated_at=NOW()
       WHERE po_id=$2 RETURNING po_id, status`,
      [status, req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Purchase order not found.' });
    res.json({ purchase_order: result.rows[0] });
  } catch (err) {
    console.error('Update PO status error:', err);
    res.status(500).json({ error: 'Could not update status.' });
  }
});

// POST /api/purchase-orders/:id/receive
// Marks PO as received and auto-updates inventory stock levels
router.post('/:id/receive', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemsResult = await client.query(
      `SELECT po_item_id, inventory_item_id, description, quantity
       FROM purchase_order_items WHERE po_id=$1`,
      [req.params.id]
    );

    for (const item of itemsResult.rows) {
      await client.query(
        `UPDATE purchase_order_items
         SET received_quantity = quantity WHERE po_item_id=$1`,
        [item.po_item_id]
      );

      if (item.inventory_item_id) {
        await client.query(
          `UPDATE inventory_items
           SET quantity_on_hand = quantity_on_hand + $1, updated_at=NOW()
           WHERE item_id=$2`,
          [item.quantity, item.inventory_item_id]
        );

        await client.query(
          `INSERT INTO inventory_transactions
           (item_id, change_amount, reason, note, created_by)
           VALUES ($1,$2,'restock',$3,$4)`,
          [item.inventory_item_id, item.quantity,
           `Received via PO #${req.params.id}`, req.user.userId]
        );
      }
    }

    await client.query(
      `UPDATE purchase_orders SET status='received', updated_at=NOW()
       WHERE po_id=$1`,
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Receive PO error:', err);
    res.status(500).json({ error: 'Could not receive purchase order.' });
  } finally {
    client.release();
  }
});

// DELETE /api/purchase-orders/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM purchase_orders WHERE po_id=$1 AND status='draft'
       RETURNING po_id`,
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({
        error: 'Purchase order not found or cannot be deleted (only drafts can be deleted).'
      });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete PO error:', err);
    res.status(500).json({ error: 'Could not delete purchase order.' });
  }
});

module.exports = router;