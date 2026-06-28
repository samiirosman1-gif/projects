const express = require('express');
const pool = require('../db');
const { verifyToken, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken, requirePermission('manage_suppliers'));

// GET /api/suppliers
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT supplier_id, name, contact_name, email, phone,
              address, payment_terms, is_active, created_at
       FROM suppliers ORDER BY name`
    );
    res.json({ suppliers: result.rows });
  } catch (err) {
    console.error('List suppliers error:', err);
    res.status(500).json({ error: 'Could not load suppliers.' });
  }
});

// POST /api/suppliers
router.post('/', async (req, res) => {
  const { name, contact_name, email, phone, address, payment_terms } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });
  try {
    const result = await pool.query(
      `INSERT INTO suppliers (name, contact_name, email, phone, address, payment_terms)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [name, contact_name||null, email||null, phone||null,
       address||null, payment_terms||null]
    );
    res.status(201).json({ supplier: result.rows[0] });
  } catch (err) {
    console.error('Create supplier error:', err);
    res.status(500).json({ error: 'Could not create supplier.' });
  }
});

// PATCH /api/suppliers/:id
router.patch('/:id', async (req, res) => {
  const { name, contact_name, email, phone, address, payment_terms, is_active } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });
  try {
    const result = await pool.query(
      `UPDATE suppliers
       SET name=$1, contact_name=$2, email=$3, phone=$4,
           address=$5, payment_terms=$6, is_active=$7
       WHERE supplier_id=$8 RETURNING *`,
      [name, contact_name||null, email||null, phone||null,
       address||null, payment_terms||null,
       is_active !== undefined ? is_active : true, req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Supplier not found.' });
    res.json({ supplier: result.rows[0] });
  } catch (err) {
    console.error('Update supplier error:', err);
    res.status(500).json({ error: 'Could not update supplier.' });
  }
});

// DELETE /api/suppliers/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM suppliers WHERE supplier_id=$1 RETURNING supplier_id',
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Supplier not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete supplier error:', err);
    res.status(500).json({ error: 'Could not delete supplier.' });
  }
});

module.exports = router;