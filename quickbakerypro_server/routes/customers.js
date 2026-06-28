const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// GET /api/customers
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT customer_id, full_name, email, phone, address,
             notes, loyalty_points, total_spent, visit_count,
             is_active, created_at
      FROM customers WHERE 1=1
    `;
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (full_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)`;
    }
    query += ' ORDER BY full_name';
    const result = await pool.query(query, params);
    res.json({ customers: result.rows });
  } catch (err) {
    console.error('List customers error:', err);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

// GET /api/customers/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT customer_id, full_name, email, phone, address,
              notes, loyalty_points, total_spent, visit_count,
              is_active, created_at
       FROM customers WHERE customer_id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Customer not found.' });
    res.json({ customer: result.rows[0] });
  } catch (err) {
    console.error('Get customer error:', err);
    res.status(500).json({ error: 'Could not load customer.' });
  }
});

// POST /api/customers
router.post('/', async (req, res) => {
  const { full_name, email, phone, address, notes } = req.body;
  if (!full_name)
    return res.status(400).json({ error: 'full_name is required.' });
  try {
    const result = await pool.query(
      `INSERT INTO customers (full_name, email, phone, address, notes)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [full_name, email||null, phone||null, address||null, notes||null]
    );
    res.status(201).json({ customer: result.rows[0] });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'A customer with that email already exists.' });
    console.error('Create customer error:', err);
    res.status(500).json({ error: 'Could not create customer.' });
  }
});

// PATCH /api/customers/:id
router.patch('/:id', async (req, res) => {
  const { full_name, email, phone, address, notes, is_active } = req.body;
  if (!full_name)
    return res.status(400).json({ error: 'full_name is required.' });
  try {
    const result = await pool.query(
      `UPDATE customers
       SET full_name=$1, email=$2, phone=$3, address=$4,
           notes=$5, is_active=$6, updated_at=NOW()
       WHERE customer_id=$7 RETURNING *`,
      [full_name, email||null, phone||null, address||null,
       notes||null, is_active !== undefined ? is_active : true, req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Customer not found.' });
    res.json({ customer: result.rows[0] });
  } catch (err) {
    console.error('Update customer error:', err);
    res.status(500).json({ error: 'Could not update customer.' });
  }
});

// DELETE /api/customers/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM customers WHERE customer_id=$1 RETURNING customer_id',
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Customer not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete customer error:', err);
    res.status(500).json({ error: 'Could not delete customer.' });
  }
});

module.exports = router;