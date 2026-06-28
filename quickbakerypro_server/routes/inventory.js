const express = require('express');
const pool = require('../db');
const { verifyToken, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken, requirePermission('manage_inventory'));

const VALID_REASONS = ['restock', 'used_in_production', 'waste', 'correction'];

// GET /api/inventory
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT item_id, name, category, unit, quantity_on_hand,
              reorder_threshold, unit_cost, updated_at
       FROM inventory_items
       ORDER BY category, name`
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error('List inventory error:', err);
    res.status(500).json({ error: 'Could not load inventory.' });
  }
});

// POST /api/inventory
router.post('/', async (req, res) => {
  const { name, category, unit, quantity_on_hand, reorder_threshold, unit_cost } = req.body;
  if (!name || !unit) {
    return res.status(400).json({ error: 'name and unit are required.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO inventory_items (name, category, unit, quantity_on_hand, reorder_threshold, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING item_id, name, category, unit, quantity_on_hand, reorder_threshold, unit_cost, updated_at`,
      [name, category || 'Ingredient', unit,
       quantity_on_hand || 0, reorder_threshold || 0, unit_cost || 0]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    console.error('Create inventory error:', err);
    res.status(500).json({ error: 'Could not create item.' });
  }
});

// PATCH /api/inventory/:id
router.patch('/:id', async (req, res) => {
  const { name, category, unit, reorder_threshold, unit_cost } = req.body;
  if (!name || !unit) {
    return res.status(400).json({ error: 'name and unit are required.' });
  }
  try {
    const result = await pool.query(
      `UPDATE inventory_items
       SET name=$1, category=$2, unit=$3, reorder_threshold=$4, unit_cost=$5, updated_at=NOW()
       WHERE item_id=$6
       RETURNING item_id, name, category, unit, quantity_on_hand, reorder_threshold, unit_cost, updated_at`,
      [name, category || 'Ingredient', unit,
       reorder_threshold || 0, unit_cost || 0, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error('Update inventory error:', err);
    res.status(500).json({ error: 'Could not update item.' });
  }
});

// DELETE /api/inventory/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM inventory_items WHERE item_id=$1 RETURNING item_id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete inventory error:', err);
    res.status(500).json({ error: 'Could not delete item.' });
  }
});

// POST /api/inventory/:id/adjust
router.post('/:id/adjust', async (req, res) => {
  const { change_amount, reason, note } = req.body;
  const itemId = req.params.id;

  if (typeof change_amount !== 'number' || change_amount === 0) {
    return res.status(400).json({ error: 'change_amount must be a non-zero number.' });
  }
  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${VALID_REASONS.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updateResult = await client.query(
      `UPDATE inventory_items
       SET quantity_on_hand = quantity_on_hand + $1, updated_at = NOW()
       WHERE item_id = $2
       RETURNING item_id, name, quantity_on_hand`,
      [change_amount, itemId]
    );
    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item not found.' });
    }
    if (updateResult.rows[0].quantity_on_hand < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This change would make quantity negative.' });
    }
    await client.query(
      `INSERT INTO inventory_transactions (item_id, change_amount, reason, note, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [itemId, change_amount, reason, note || null, req.user.userId]
    );
    await client.query('COMMIT');
    res.json({ item: updateResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Adjust inventory error:', err);
    res.status(500).json({ error: 'Could not adjust stock.' });
  } finally {
    client.release();
  }
});

// GET /api/inventory/:id/transactions
router.get('/:id/transactions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.transaction_id, t.change_amount, t.reason, t.note,
              t.created_at, u.full_name AS created_by_name
       FROM inventory_transactions t
       LEFT JOIN users u ON u.user_id = t.created_by
       WHERE t.item_id = $1
       ORDER BY t.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('List transactions error:', err);
    res.status(500).json({ error: 'Could not load transaction history.' });
  }
});

module.exports = router;