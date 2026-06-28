const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();
const SALT_ROUNDS = 10;

// POST /api/auth/register
router.post('/register', async (req, res) => {
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

    const roleId = roleResult.rows[0].role_id;
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const insertResult = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, full_name, email, role_id, created_at`,
      [full_name, email, passwordHash, roleId]
    );

    res.status(201).json({ user: insertResult.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong creating the user.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }

  try {
    const userResult = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.password_hash, u.is_active, r.role_name
       FROM users u
       JOIN roles r ON r.role_id = u.role_id
       WHERE u.email = $1`,
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const permissionsResult = await pool.query(
      `SELECT p.permission_name
       FROM role_permissions rp
       JOIN permissions p ON p.permission_id = rp.permission_id
       JOIN roles r ON r.role_id = rp.role_id
       WHERE r.role_name = $1`,
      [user.role_name]
    );
    const permissions = permissionsResult.rows.map((row) => row.permission_name);

    const token = jwt.sign(
      { userId: user.user_id, email: user.email, role: user.role_name },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: {
        id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        role: user.role_name,
        permissions,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong logging in.' });
  }
});

module.exports = router;