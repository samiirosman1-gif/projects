const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// GET /api/promotions — list all active promotions
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.promotion_id, p.name, p.type, p.code,
              p.discount_value, p.buy_quantity, p.get_quantity,
              p.apply_to_product_id, p.min_order_amount,
              p.is_active, p.expires_at, p.created_at,
              pr.name AS apply_to_product_name
       FROM promotions p
       LEFT JOIN products pr ON pr.product_id = p.apply_to_product_id
       ORDER BY p.created_at DESC`
    );
    res.json({ promotions: result.rows });
  } catch (err) {
    console.error('List promotions error:', err);
    res.status(500).json({ error: 'Could not load promotions.' });
  }
});

// GET /api/promotions/code/:code — look up a promo code
router.get('/code/:code', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM promotions
       WHERE UPPER(code) = UPPER($1)
         AND type = 'code'
         AND is_active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [req.params.code]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Invalid or expired promo code.' });
    res.json({ promotion: result.rows[0] });
  } catch (err) {
    console.error('Lookup promo code error:', err);
    res.status(500).json({ error: 'Could not look up promo code.' });
  }
});

// POST /api/promotions — create promotion
router.post('/', async (req, res) => {
  const {
    name, type, code, discount_value, buy_quantity,
    get_quantity, apply_to_product_id, min_order_amount, expires_at,
  } = req.body;
  if (!name || !type)
    return res.status(400).json({ error: 'Name and type are required.' });
  try {
    const result = await pool.query(
      `INSERT INTO promotions
         (name, type, code, discount_value, buy_quantity, get_quantity,
          apply_to_product_id, min_order_amount, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        name, type,
        code ? code.toUpperCase() : null,
        discount_value || 0,
        buy_quantity || 0,
        get_quantity || 0,
        apply_to_product_id || null,
        min_order_amount || 0,
        expires_at || null,
      ]
    );
    res.status(201).json({ promotion: result.rows[0] });
  } catch (err) {
    console.error('Create promotion error:', err);
    res.status(500).json({ error: 'Could not create promotion.' });
  }
});

// PATCH /api/promotions/:id — toggle active / update
router.patch('/:id', async (req, res) => {
  const { is_active, name, discount_value, expires_at } = req.body;
  try {
    const result = await pool.query(
      `UPDATE promotions
       SET is_active = COALESCE($1, is_active),
           name = COALESCE($2, name),
           discount_value = COALESCE($3, discount_value),
           expires_at = COALESCE($4, expires_at)
       WHERE promotion_id = $5
       RETURNING *`,
      [is_active, name, discount_value, expires_at, req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Promotion not found.' });
    res.json({ promotion: result.rows[0] });
  } catch (err) {
    console.error('Update promotion error:', err);
    res.status(500).json({ error: 'Could not update promotion.' });
  }
});

// DELETE /api/promotions/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM promotions WHERE promotion_id = $1',
        [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete promotion error:', err);
    res.status(500).json({ error: 'Could not delete promotion.' });
  }
});

module.exports = router;