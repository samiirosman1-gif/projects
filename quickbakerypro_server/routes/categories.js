const express = require('express');
const pool = require('../db');
const { verifyToken, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken, requirePermission('manage_pricing'));

// GET /api/categories
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT category_id, name, description, created_at
       FROM categories ORDER BY name`
    );
    res.json({ categories: result.rows });
  } catch (err) {
    console.error('List categories error:', err);
    res.status(500).json({ error: 'Could not load categories.' });
  }
});

// POST /api/categories
router.post('/', async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });

  try {
    const result = await pool.query(
      `INSERT INTO categories (name, description)
       VALUES ($1, $2)
       RETURNING category_id, name, description, created_at`,
      [name, description || null]
    );
    res.status(201).json({ category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A category with that name already exists.' });
    }
    console.error('Create category error:', err);
    res.status(500).json({ error: 'Could not create category.' });
  }
});

// PATCH /api/categories/:id
router.patch('/:id', async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });

  try {
    const result = await pool.query(
      `UPDATE categories SET name = $1, description = $2
       WHERE category_id = $3
       RETURNING category_id, name, description`,
      [name, description || null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found.' });
    }
    res.json({ category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A category with that name already exists.' });
    }
    console.error('Update category error:', err);
    res.status(500).json({ error: 'Could not update category.' });
  }
});

// DELETE /api/categories/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM categories WHERE category_id = $1 RETURNING category_id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete category error:', err);
    res.status(500).json({ error: 'Could not delete category.' });
  }
});

module.exports = router;