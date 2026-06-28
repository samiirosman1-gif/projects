const express = require('express');
const pool    = require('../db');

const router = express.Router();

// POST /api/seed
// Seeds default roles and permissions — safe to call multiple times (ON CONFLICT DO NOTHING)
// No auth required — called during setup wizard before any users exist
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Default roles ────────────────────────────────────────────────────
    const roles = [
      { name: 'CEO',         desc: 'Full system access' },
      { name: 'Shareholder', desc: 'Financial reports and analytics' },
      { name: 'Admin',       desc: 'System administration' },
      { name: 'Manager',     desc: 'Operations management' },
      { name: 'Baker',       desc: 'Production and inventory' },
      { name: 'Cashier',     desc: 'Point of sale and customers' },
    ];

    for (const role of roles) {
      await client.query(
        `INSERT INTO roles (role_name, description)
         VALUES ($1, $2) ON CONFLICT (role_name) DO NOTHING`,
        [role.name, role.desc]
      );
    }

    // ── Default permissions ───────────────────────────────────────────────
    const permissions = [
      'process_sales',
      'view_financial_reports',
      'view_shareholder_reports',
      'manage_inventory',
      'manage_suppliers',
      'manage_pricing',
      'manage_users',
      'manage_staff',
      'manage_recipes',
      'manage_settings',
    ];

    for (const perm of permissions) {
      await client.query(
        `INSERT INTO permissions (permission_name)
         VALUES ($1) ON CONFLICT (permission_name) DO NOTHING`,
        [perm]
      );
    }

    // ── Role → Permission mapping ─────────────────────────────────────────
    const rolePerms = {
      'CEO': permissions, // all permissions
      'Shareholder': ['view_financial_reports', 'view_shareholder_reports'],
      'Admin': [
        'process_sales', 'view_financial_reports', 'manage_inventory',
        'manage_suppliers', 'manage_pricing', 'manage_users',
        'manage_staff', 'manage_recipes', 'manage_settings',
      ],
      'Manager': [
        'process_sales', 'view_financial_reports', 'manage_inventory',
        'manage_suppliers', 'manage_pricing', 'manage_staff', 'manage_recipes',
      ],
      'Baker': ['manage_inventory', 'manage_recipes'],
      'Cashier': ['process_sales'],
    };

    for (const [roleName, perms] of Object.entries(rolePerms)) {
      const roleRow = await client.query(
        `SELECT role_id FROM roles WHERE role_name = $1`, [roleName]
      );
      if (roleRow.rows.length === 0) continue;
      const roleId = roleRow.rows[0].role_id;

      for (const perm of perms) {
        const permRow = await client.query(
          `SELECT permission_id FROM permissions WHERE permission_name = $1`, [perm]
        );
        if (permRow.rows.length === 0) continue;
        const permId = permRow.rows[0].permission_id;

        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [roleId, permId]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Default roles and permissions seeded.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed error:', err);
    res.status(500).json({ error: 'Seed failed: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;