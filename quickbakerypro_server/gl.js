// ── General-Ledger posting engine ────────────────────────────────────────────
// Double-entry helper shared by all modules. Every posting goes through
// postEntry(), which validates that debits == credits before writing.
//
// A "line" is: { systemKey | expenseCategory | accountId, debit, credit, description }
//   - systemKey       → resolves to the seeded account with that system_key
//   - expenseCategory → resolves to the expense account whose name matches the
//                       category (falls back to 'Other' / expense_other)
//   - accountId       → explicit account id (used by manual journal entries)
const pool = require('./db');

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function _resolveAccountId(client, line) {
  if (line.accountId) return line.accountId;
  if (line.systemKey) {
    const r = await client.query(
      'SELECT account_id FROM accounts WHERE system_key = $1', [line.systemKey]);
    if (!r.rows.length) throw new Error(`No account for system_key '${line.systemKey}'`);
    return r.rows[0].account_id;
  }
  if (line.expenseCategory) {
    const r = await client.query(
      `SELECT account_id FROM accounts
       WHERE account_type = 'expense' AND lower(name) = lower($1) LIMIT 1`,
      [line.expenseCategory]);
    if (r.rows.length) return r.rows[0].account_id;
    const fb = await client.query(
      "SELECT account_id FROM accounts WHERE system_key = 'expense_other'");
    return fb.rows[0].account_id;
  }
  throw new Error('Journal line needs systemKey, expenseCategory, or accountId');
}

// Post a balanced journal entry. Returns entry_id, or null if there was nothing
// to post (all lines zero). Must be called inside a transaction (pass the client).
async function postEntry(client, {
  date, memo, sourceType = 'manual', sourceId = null, createdBy = null, lines = [],
}) {
  // Resolve accounts + drop empty lines
  const resolved = [];
  for (const l of lines) {
    const debit  = round2(l.debit);
    const credit = round2(l.credit);
    if (debit === 0 && credit === 0) continue;
    resolved.push({
      accountId: await _resolveAccountId(client, l),
      debit, credit, description: l.description || null,
    });
  }
  if (!resolved.length) return null;

  const totalDr = round2(resolved.reduce((s, l) => s + l.debit, 0));
  const totalCr = round2(resolved.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(totalDr - totalCr) > 0.01) {
    throw new Error(
      `Unbalanced journal entry (${sourceType}#${sourceId}): Dr ${totalDr} ≠ Cr ${totalCr}`);
  }

  const entry = await client.query(
    `INSERT INTO journal_entries (entry_date, memo, source_type, source_id, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING entry_id`,
    [date || new Date().toISOString().split('T')[0],
     memo || null, sourceType, sourceId, createdBy]);
  const entryId = entry.rows[0].entry_id;

  for (const l of resolved) {
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [entryId, l.accountId, l.debit, l.credit, l.description]);
  }
  return entryId;
}

// Remove any posted entries for a given source (used before re-posting on edit).
async function reverseEntries(client, sourceType, sourceId) {
  await client.query(
    'DELETE FROM journal_entries WHERE source_type = $1 AND source_id = $2',
    [sourceType, sourceId]);
}

// Has a create-type entry already been posted for this source? (idempotent backfill)
async function entryExists(client, sourceType, sourceId) {
  const r = await client.query(
    'SELECT 1 FROM journal_entries WHERE source_type = $1 AND source_id = $2 LIMIT 1',
    [sourceType, sourceId]);
  return r.rows.length > 0;
}

// Map a sale/expense payment_method string → the asset/liability account it hits.
function paymentAccountKey(method) {
  switch ((method || 'cash').toLowerCase()) {
    case 'card':          return 'bank';        // card settles to bank
    case 'bank_transfer': return 'bank';
    case 'bank':          return 'bank';
    case 'cheque':        return 'bank';
    case 'credit_card':   return 'credit_card'; // money owed, not paid from cash
    case 'cash':
    default:              return 'cash';
  }
}

// Best-effort COGS lines for a set of sale items. Looks up product cost.
// Returns [] when no cost data is available (COGS line is simply omitted).
async function cogsLinesForSale(client, saleId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(si.quantity * p.cost), 0) AS cogs
     FROM sale_items si
     JOIN products p ON p.product_id = si.product_id
     WHERE si.sale_id = $1 AND p.cost IS NOT NULL`, [saleId]);
  const cogs = round2(r.rows[0]?.cogs);
  if (cogs <= 0) return [];
  return [
    { systemKey: 'cogs',      debit: cogs,  credit: 0, description: 'Cost of goods sold' },
    { systemKey: 'inventory', debit: 0, credit: cogs, description: 'Inventory reduction' },
  ];
}

module.exports = {
  postEntry, reverseEntries, entryExists,
  paymentAccountKey, cogsLinesForSale, round2,
};
