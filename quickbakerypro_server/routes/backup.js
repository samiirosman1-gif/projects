const express = require('express');
const pool    = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// ── Only CEO / Admin can backup or restore ────────────────────────────────
function requireAdmin(req, res, next) {
  const role = (req.user?.role || '').toLowerCase();
  if (role === 'ceo' || role === 'admin') return next();
  return res.status(403).json({ error: 'Only CEO or Admin can perform backups.' });
}

// ── Tables to back up, in dependency order (parents before children) ──────
const TABLES = [
  'roles',
  'permissions',
  'role_permissions',
  'users',
  'categories',
  'products',
  'suppliers',
  'customers',
  'inventory_items',
  'inventory_transactions',
  'purchase_orders',
  'purchase_order_items',
  'promotions',
  'sales',
  'sale_items',
];

// ── Restore order: delete children first, then parents ────────────────────
const RESTORE_ORDER = [...TABLES].reverse();

// ─────────────────────────────────────────────────────────────────────────
// GET /api/backup/full
// Returns a full JSON dump of all tables + metadata
// ─────────────────────────────────────────────────────────────────────────
router.get('/full', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const backup = {
      app:         'QuickBakeryPro',
      version:     '1.0.0',
      exported_at: new Date().toISOString(),
      exported_by: req.user.email,
      tables:      {},
    };

    for (const table of TABLES) {
      const result = await client.query(`SELECT * FROM ${table} ORDER BY 1`);
      backup.tables[table] = result.rows;
    }

    // Get current sequence values so IDs continue correctly after restore
    const seqResult = await client.query(`
      SELECT sequencename AS sequence_name, last_value
      FROM pg_sequences
      WHERE schemaname = 'public'
        AND last_value IS NOT NULL
    `);
    backup.sequences = seqResult.rows;

    res.json(backup);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/backup/restore
// Wipes all tables and restores from the backup JSON
// Body: the full backup JSON object
// ─────────────────────────────────────────────────────────────────────────
router.post('/restore', requireAdmin, async (req, res) => {
  const backup = req.body;

  // Validate it's a QuickBakeryPro backup
  if (!backup || backup.app !== 'QuickBakeryPro' || !backup.tables) {
    return res.status(400).json({ error: 'Invalid backup file.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Disable foreign key checks during restore
    await client.query('SET session_replication_role = replica');

    // Delete all data in reverse dependency order
    for (const table of RESTORE_ORDER) {
      await client.query(`DELETE FROM ${table}`);
    }

    // Re-insert all rows in dependency order
    for (const table of TABLES) {
      const rows = backup.tables[table];
      if (!rows || rows.length === 0) continue;

      for (const row of rows) {
        const cols   = Object.keys(row);
        const values = Object.values(row);
        const colStr = cols.map(c => `"${c}"`).join(', ');
        const valStr = cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${table} (${colStr}) VALUES (${valStr})`,
          values
        );
      }
    }

    // Restore sequence values so next inserts get correct IDs
    if (backup.sequences && backup.sequences.length > 0) {
      for (const seq of backup.sequences) {
        const seqName = seq.sequence_name || seq.sequencename;
        if (seqName && seq.last_value) {
          await client.query(
            `SELECT setval('${seqName}', $1, true)`,
            [seq.last_value]
          );
        }
      }
    }

    // Re-enable foreign key checks
    await client.query('SET session_replication_role = DEFAULT');

    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Restore completed successfully.',
      restored_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    await client.query('SET session_replication_role = DEFAULT');
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────
// DELETE /api/backup/reset
// Factory reset — wipes ALL tables, leaves schema intact
// ─────────────────────────────────────────────────────────────────────────
router.delete('/reset', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET session_replication_role = replica');

    // Delete all data in reverse dependency order
    for (const table of RESTORE_ORDER) {
      await client.query(`DELETE FROM ${table}`);
    }

    // Reset all sequences back to 1
    const seqResult = await client.query(`
      SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
    `);
    for (const row of seqResult.rows) {
      await client.query(`ALTER SEQUENCE ${row.sequencename} RESTART WITH 1`);
    }

    await client.query('SET session_replication_role = DEFAULT');
    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Factory reset complete. All data wiped.',
      reset_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    await client.query('SET session_replication_role = DEFAULT');
    console.error('Factory reset error:', err);
    res.status(500).json({ error: 'Factory reset failed: ' + err.message });
  } finally {
    client.release();
  }
});