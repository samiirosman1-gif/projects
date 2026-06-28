const express = require('express');
const pool    = require('../db');
const gl      = require('../gl');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

const BALANCE_EXPR = `
  CASE a.normal_balance
    WHEN 'debit'  THEN a.opening_balance + COALESCE(SUM(jl.debit)  - SUM(jl.credit), 0)
    WHEN 'credit' THEN a.opening_balance + COALESCE(SUM(jl.credit) - SUM(jl.debit),  0)
  END`;

const VOID_FILTER = `(je.is_void = false OR je.is_void IS NULL)`;

// ── GET /api/accounts ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        a.account_id, a.account_number, a.name, a.account_type,
        a.detail_type, a.description, a.system_key, a.normal_balance,
        a.opening_balance, a.is_active, a.parent_account_id,
        COALESCE(SUM(jl.debit),  0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit,
        ${BALANCE_EXPR} AS balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.account_id
      LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id AND ${VOID_FILTER}
      WHERE a.is_active = true
      GROUP BY a.account_id
      ORDER BY a.account_number`);
    res.json({ accounts: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/accounts ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    account_number, name, account_type, detail_type,
    description, normal_balance, opening_balance = 0, parent_account_id,
  } = req.body;
  if (!name)         return res.status(400).json({ error: 'name is required.' });
  if (!account_type) return res.status(400).json({ error: 'account_type is required.' });

  const nb = normal_balance ||
    (account_type === 'asset' || account_type === 'expense' ? 'debit' : 'credit');

  try {
    const r = await pool.query(`
      INSERT INTO accounts
        (account_number, name, account_type, detail_type, description,
         normal_balance, opening_balance, parent_account_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [account_number || null, name, account_type, detail_type || null,
       description || null, nb, parseFloat(opening_balance) || 0,
       parent_account_id || null]);
    res.status(201).json({ account: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/accounts/journal-entries ────────────────────────────────────
router.get('/journal-entries', async (req, res) => {
  try {
    const { from, to, source_type, search } = req.query;
    let q = `
      SELECT je.entry_id, je.entry_number, je.entry_date, je.memo,
             je.source_type, je.source_id, je.is_void, je.created_at,
             u.full_name AS created_by_name,
             COALESCE(SUM(jl.debit),  0) AS total_debit,
             COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM journal_entries je
      LEFT JOIN users u ON u.user_id = je.created_by
      LEFT JOIN journal_lines jl ON jl.entry_id = je.entry_id
      WHERE 1=1`;
    const p = [];
    if (from)        { p.push(from);        q += ` AND je.entry_date >= $${p.length}`; }
    if (to)          { p.push(to);          q += ` AND je.entry_date <= $${p.length}`; }
    if (source_type) { p.push(source_type); q += ` AND je.source_type = $${p.length}`; }
    if (search) {
      p.push(`%${search}%`);
      q += ` AND (je.memo ILIKE $${p.length} OR je.entry_number ILIKE $${p.length})`;
    }
    q += ` GROUP BY je.entry_id, u.full_name ORDER BY je.entry_date DESC, je.entry_id DESC`;
    const r = await pool.query(q, p);
    res.json({ entries: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/accounts/journal-entries/:id ────────────────────────────────
router.get('/journal-entries/:id', async (req, res) => {
  try {
    const entry = await pool.query(`
      SELECT je.*, u.full_name AS created_by_name
      FROM journal_entries je
      LEFT JOIN users u ON u.user_id = je.created_by
      WHERE je.entry_id = $1`, [req.params.id]);
    if (!entry.rows.length) return res.status(404).json({ error: 'Entry not found.' });

    const lines = await pool.query(`
      SELECT jl.*, a.account_number, a.name AS account_name, a.account_type
      FROM journal_lines jl
      JOIN accounts a ON a.account_id = jl.account_id
      WHERE jl.entry_id = $1 ORDER BY jl.line_id`, [req.params.id]);

    res.json({ entry: entry.rows[0], lines: lines.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/accounts/journal-entries ───────────────────────────────────
router.post('/journal-entries', async (req, res) => {
  const { date, memo, lines = [] } = req.body;
  if (!lines.length) return res.status(400).json({ error: 'At least one line is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entryId = await gl.postEntry(client, {
      date, memo, sourceType: 'manual', sourceId: null,
      createdBy: req.user.userId,
      lines: lines.map(l => ({
        accountId: l.account_id,
        debit:     parseFloat(l.debit)  || 0,
        credit:    parseFloat(l.credit) || 0,
        description: l.description || null,
      })),
    });
    await client.query('COMMIT');
    res.status(201).json({ entry_id: entryId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

// ── POST /api/accounts/journal-entries/:id/void ───────────────────────────
router.post('/journal-entries/:id/void', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE journal_entries SET is_void=true
       WHERE entry_id=$1 AND (is_void=false OR is_void IS NULL)
       RETURNING entry_id`, [req.params.id]);
    if (!r.rows.length) return res.status(400).json({ error: 'Entry not found or already voided.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/accounts/reports/trial-balance ───────────────────────────────
router.get('/reports/trial-balance', async (req, res) => {
  try {
    const { as_of } = req.query;
    const params = [];
    const dateFilter = as_of ? (params.push(as_of), `AND je.entry_date <= $${params.length}`) : '';

    const r = await pool.query(`
      SELECT
        a.account_id, a.account_number, a.name, a.account_type,
        a.detail_type, a.normal_balance, a.opening_balance,
        COALESCE(SUM(jl.debit),  0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit,
        CASE a.normal_balance
          WHEN 'debit'
          THEN GREATEST(a.opening_balance + COALESCE(SUM(jl.debit) - SUM(jl.credit), 0), 0)
          ELSE 0
        END AS debit_balance,
        CASE a.normal_balance
          WHEN 'credit'
          THEN GREATEST(a.opening_balance + COALESCE(SUM(jl.credit) - SUM(jl.debit), 0), 0)
          ELSE 0
        END AS credit_balance
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.account_id
      LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id
        AND ${VOID_FILTER} ${dateFilter}
      WHERE a.is_active = true
      GROUP BY a.account_id
      ORDER BY a.account_number`, params);

    const totalDebit  = gl.round2(r.rows.reduce((s, x) => s + parseFloat(x.debit_balance),  0));
    const totalCredit = gl.round2(r.rows.reduce((s, x) => s + parseFloat(x.credit_balance), 0));

    res.json({
      accounts: r.rows,
      total_debit:  totalDebit,
      total_credit: totalCredit,
      is_balanced:  Math.abs(totalDebit - totalCredit) < 0.02,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/accounts/reports/balance-sheet ───────────────────────────────
router.get('/reports/balance-sheet', async (req, res) => {
  try {
    const { as_of } = req.query;
    const params = [];
    const dateFilter = as_of ? (params.push(as_of), `AND je.entry_date <= $${params.length}`) : '';

    const [acctR, incR, expR] = await Promise.all([
      pool.query(`
        SELECT a.account_id, a.account_number, a.name, a.account_type,
               a.detail_type, a.normal_balance, a.parent_account_id,
               ${BALANCE_EXPR} AS balance
        FROM accounts a
        LEFT JOIN journal_lines jl ON jl.account_id = a.account_id
        LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id
          AND ${VOID_FILTER} ${dateFilter}
        WHERE a.is_active = true AND a.account_type IN ('asset','liability','equity')
        GROUP BY a.account_id ORDER BY a.account_number`, params),

      pool.query(`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM journal_lines jl
        JOIN journal_entries je ON je.entry_id = jl.entry_id AND ${VOID_FILTER} ${dateFilter}
        JOIN accounts a ON a.account_id = jl.account_id AND a.account_type = 'income'`, params),

      pool.query(`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM journal_lines jl
        JOIN journal_entries je ON je.entry_id = jl.entry_id AND ${VOID_FILTER} ${dateFilter}
        JOIN accounts a ON a.account_id = jl.account_id AND a.account_type = 'expense'`, params),
    ]);

    const accounts       = acctR.rows;
    const netIncome      = gl.round2(parseFloat(incR.rows[0].total) - parseFloat(expR.rows[0].total));
    const assets         = accounts.filter(a => a.account_type === 'asset');
    const liabilities    = accounts.filter(a => a.account_type === 'liability');
    const equity         = accounts.filter(a => a.account_type === 'equity');
    const totalAssets    = gl.round2(assets.reduce((s, a)      => s + parseFloat(a.balance || 0), 0));
    const totalLiab      = gl.round2(liabilities.reduce((s, a) => s + parseFloat(a.balance || 0), 0));
    const totalEquity    = gl.round2(equity.reduce((s, a)      => s + parseFloat(a.balance || 0), 0) + netIncome);

    res.json({
      assets, liabilities, equity, net_income: netIncome,
      total_assets: totalAssets, total_liabilities: totalLiab, total_equity: totalEquity,
      total_liabilities_equity: gl.round2(totalLiab + totalEquity),
      is_balanced: Math.abs(totalAssets - (totalLiab + totalEquity)) < 0.02,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/accounts/reports/profit-loss ─────────────────────────────────
router.get('/reports/profit-loss', async (req, res) => {
  try {
    const { from, to } = req.query;
    const conds = [], params = [];
    if (from) { params.push(from); conds.push(`je.entry_date >= $${params.length}`); }
    if (to)   { params.push(to);   conds.push(`je.entry_date <= $${params.length}`); }
    const dateFilter = conds.length ? `AND ${conds.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT
        a.account_id, a.account_number, a.name, a.account_type,
        a.detail_type, a.normal_balance,
        CASE a.normal_balance
          WHEN 'credit' THEN COALESCE(SUM(jl.credit) - SUM(jl.debit), 0)
          ELSE               COALESCE(SUM(jl.debit)  - SUM(jl.credit), 0)
        END AS period_balance
      FROM accounts a
      JOIN journal_lines jl ON jl.account_id = a.account_id
      JOIN journal_entries je ON je.entry_id = jl.entry_id
        AND ${VOID_FILTER} ${dateFilter}
      WHERE a.account_type IN ('income','expense')
      GROUP BY a.account_id
      HAVING COALESCE(SUM(jl.debit), 0) != 0 OR COALESCE(SUM(jl.credit), 0) != 0
      ORDER BY a.account_type DESC, a.account_number`, params);

    const income   = r.rows.filter(a => a.account_type === 'income');
    const expenses = r.rows.filter(a => a.account_type === 'expense');
    const totalIncome   = gl.round2(income.reduce((s, a)   => s + parseFloat(a.period_balance || 0), 0));
    const totalExpenses = gl.round2(expenses.reduce((s, a) => s + parseFloat(a.period_balance || 0), 0));

    res.json({
      income, expenses,
      total_income:   totalIncome,
      total_expenses: totalExpenses,
      net_income:     gl.round2(totalIncome - totalExpenses),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/accounts/reports/general-ledger ──────────────────────────────
router.get('/reports/general-ledger', async (req, res) => {
  try {
    const { account_id, from, to } = req.query;
    const conds = [], params = [];
    if (account_id) { params.push(account_id); conds.push(`jl.account_id = $${params.length}`); }
    if (from)       { params.push(from);       conds.push(`je.entry_date >= $${params.length}`); }
    if (to)         { params.push(to);         conds.push(`je.entry_date <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT jl.line_id, jl.debit, jl.credit, jl.description,
             je.entry_id, je.entry_number, je.entry_date, je.memo,
             je.source_type, je.source_id, je.is_void,
             a.account_id, a.account_number, a.name AS account_name,
             a.account_type, a.normal_balance
      FROM journal_lines jl
      JOIN journal_entries je ON je.entry_id = jl.entry_id
      JOIN accounts a ON a.account_id = jl.account_id
      ${where}
      ORDER BY a.account_number, je.entry_date, je.entry_id`, params);

    res.json({ lines: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/accounts/:id ─────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.*,
             ${BALANCE_EXPR} AS balance,
             COALESCE(SUM(jl.debit),  0) AS total_debit,
             COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.account_id
      LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id AND ${VOID_FILTER}
      WHERE a.account_id = $1
      GROUP BY a.account_id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account not found.' });
    res.json({ account: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/accounts/:id/register ───────────────────────────────────────
router.get('/:id/register', async (req, res) => {
  try {
    const { from, to } = req.query;
    const conds = [`jl.account_id = $1`], params = [req.params.id];
    if (from) { params.push(from); conds.push(`je.entry_date >= $${params.length}`); }
    if (to)   { params.push(to);   conds.push(`je.entry_date <= $${params.length}`); }

    const [linesR, acctR] = await Promise.all([
      pool.query(`
        SELECT jl.line_id, jl.debit, jl.credit, jl.description,
               je.entry_id, je.entry_number, je.entry_date, je.memo,
               je.source_type, je.source_id, je.is_void
        FROM journal_lines jl
        JOIN journal_entries je ON je.entry_id = jl.entry_id
        WHERE ${conds.join(' AND ')}
        ORDER BY je.entry_date, je.entry_id`, params),
      pool.query('SELECT opening_balance, normal_balance FROM accounts WHERE account_id=$1', [req.params.id]),
    ]);

    const acct = acctR.rows[0];
    let running = parseFloat(acct?.opening_balance || 0);
    const lines = linesR.rows.map(line => {
      running += acct?.normal_balance === 'debit'
        ? parseFloat(line.debit) - parseFloat(line.credit)
        : parseFloat(line.credit) - parseFloat(line.debit);
      return { ...line, running_balance: gl.round2(running) };
    });

    res.json({ lines });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /api/accounts/:id ───────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const { account_number, name, detail_type, description, is_active, opening_balance } = req.body;
  try {
    const r = await pool.query(`
      UPDATE accounts SET
        account_number  = COALESCE($1, account_number),
        name            = COALESCE($2, name),
        detail_type     = COALESCE($3, detail_type),
        description     = COALESCE($4, description),
        is_active       = COALESCE($5, is_active),
        opening_balance = COALESCE($6, opening_balance)
      WHERE account_id = $7 RETURNING *`,
      [account_number ?? null, name ?? null, detail_type ?? null,
       description ?? null, is_active ?? null,
       opening_balance != null ? parseFloat(opening_balance) : null,
       req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account not found.' });
    res.json({ account: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/accounts/:id (soft-deactivate; hard-delete if no transactions) ─
router.delete('/:id', async (req, res) => {
  try {
    const hasLines = await pool.query(
      'SELECT 1 FROM journal_lines WHERE account_id=$1 LIMIT 1', [req.params.id]);

    if (hasLines.rows.length) {
      const r = await pool.query(
        `UPDATE accounts SET is_active=false
         WHERE account_id=$1 AND system_key IS NULL RETURNING account_id`, [req.params.id]);
      if (!r.rows.length)
        return res.status(400).json({ error: 'System accounts cannot be deactivated.' });
      return res.json({ success: true, deactivated: true });
    }

    const r = await pool.query(
      `DELETE FROM accounts WHERE account_id=$1 AND system_key IS NULL RETURNING account_id`,
      [req.params.id]);
    if (!r.rows.length)
      return res.status(400).json({ error: 'System accounts cannot be deleted.' });
    res.json({ success: true, deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
