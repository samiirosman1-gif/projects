const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { verifyToken, requirePermission } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 10;

router.use(verifyToken, requirePermission('manage_users'));

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.is_active, u.created_at, r.role_name
       FROM users u
       JOIN roles r ON r.role_id = u.role_id
       ORDER BY u.created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Could not load users.' });
  }
});

// POST /api/users
router.post('/', async (req, res) => {
  const { full_name, email, password, role_name } = req.body;

  if (!full_name || !email || !password || !role_name) {
    return res.status(400).json({ error: 'full_name, email, password, and role_name are all required.' });
  }

  try {
    const roleResult = await pool.query(
      'SELECT role_id FROM roles WHERE role_name = $1',
      [role_name]
    );

    if (roleResult.rows.length === 0) {
      return res.status(400).json({ error: `Unknown role: ${role_name}` });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const insertResult = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, full_name, email, role_id, is_active, created_at`,
      [full_name, email, passwordHash, roleResult.rows[0].role_id]
    );

    res.status(201).json({ user: insertResult.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Could not create user.' });
  }
});

// PATCH /api/users/:id/role
router.patch('/:id/role', async (req, res) => {
  const { role_name } = req.body;
  if (!role_name) {
    return res.status(400).json({ error: 'role_name is required.' });
  }

  try {
    const roleResult = await pool.query(
      'SELECT role_id FROM roles WHERE role_name = $1',
      [role_name]
    );

    if (roleResult.rows.length === 0) {
      return res.status(400).json({ error: `Unknown role: ${role_name}` });
    }

    const updateResult = await pool.query(
      `UPDATE users SET role_id = $1 WHERE user_id = $2
       RETURNING user_id, full_name, email, is_active`,
      [roleResult.rows[0].role_id, req.params.id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ user: updateResult.rows[0] });
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Could not update role.' });
  }
});

// PATCH /api/users/:id/status
router.patch('/:id/status', async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false.' });
  }

  try {
    const updateResult = await pool.query(
      `UPDATE users SET is_active = $1 WHERE user_id = $2
       RETURNING user_id, full_name, email, is_active`,
      [is_active, req.params.id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ user: updateResult.rows[0] });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Could not update user status.' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
  try {
    const deleteResult = await pool.query(
      'DELETE FROM users WHERE user_id = $1 RETURNING user_id',
      [req.params.id]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Could not delete user.' });
  }
});

module.exports = router;