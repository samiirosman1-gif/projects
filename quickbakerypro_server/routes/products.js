const express = require('express');
const pool = require('../db');
const { verifyToken, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken, requirePermission('manage_pricing'));

// GET /api/products
router.get('/', async (req, res) => {
  try {
    const { search, category_id, active } = req.query;
    let query = `
      SELECT p.product_id, p.name, p.price, p.cost, p.barcode,
             p.unit, p.is_active, p.image_url, p.created_at, p.updated_at,
             c.name AS category_name, c.category_id
      FROM products p
      LEFT JOIN categories c ON c.category_id = p.category_id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`;
    }
    if (category_id) {
      params.push(category_id);
      query += ` AND p.category_id = $${params.length}`;
    }
    if (active !== undefined) {
      params.push(active === 'true');
      query += ` AND p.is_active = $${params.length}`;
    }

    query += ' ORDER BY c.name, p.name';

    const result = await pool.query(query, params);
    res.json({ products: result.rows });
  } catch (err) {
    console.error('List products error:', err);
    res.status(500).json({ error: 'Could not load products.' });
  }
});

// GET /api/products/barcode/:barcode
router.get('/barcode/:barcode', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.product_id, p.name, p.price, p.cost, p.barcode,
              p.unit, p.is_active, p.image_url, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.category_id = p.category_id
       WHERE p.barcode = $1 AND p.is_active = true`,
      [req.params.barcode]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json({ product: result.rows[0] });
  } catch (err) {
    console.error('Barcode lookup error:', err);
    res.status(500).json({ error: 'Could not look up barcode.' });
  }
});

// POST /api/products
router.post('/', async (req, res) => {
  const { name, category_id, price, cost, barcode, unit, image_url } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required.' });

  try {
    const result = await pool.query(
      `INSERT INTO products (name, category_id, price, cost, barcode, unit, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING product_id, name, category_id, price, cost, barcode, unit, image_url, is_active, created_at`,
      [
        name,
        category_id || null,
        price || 0,
        cost || 0,
        barcode || null,
        unit || 'pcs',
        image_url || null,
      ]
    );
    res.status(201).json({ product: result.rows[0] });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Could not create product.' });
  }
});

// PATCH /api/products/:id
router.patch('/:id', async (req, res) => {
  const { name, category_id, price, cost, barcode, unit, is_active, image_url } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required.' });

  try {
    const result = await pool.query(
      `UPDATE products
       SET name = $1, category_id = $2, price = $3, cost = $4,
           barcode = $5, unit = $6, is_active = $7, image_url = $8, updated_at = NOW()
       WHERE product_id = $9
       RETURNING product_id, name, category_id, price, cost, barcode, unit, is_active, image_url, updated_at`,
      [
        name,
        category_id || null,
        price || 0,
        cost || 0,
        barcode || null,
        unit || 'pcs',
        is_active !== undefined ? is_active : true,
        image_url || null,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json({ product: result.rows[0] });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Could not update product.' });
  }
});

// DELETE /api/products/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM products WHERE product_id = $1 RETURNING product_id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Could not delete product.' });
  }
});

module.exports = router;