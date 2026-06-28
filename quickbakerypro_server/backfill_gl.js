// Idempotent GL backfill — posts journal entries for existing sales, bills, expenses.
// Run from: cd quickbakerypro_server && node backfill_gl.js
// Safe to run multiple times — skips already-posted records.

require('dotenv').config();
const pool = require('./db');
const gl   = require('./gl');

async function run() {
  const client = await pool.connect();
  let posted = 0, skipped = 0;

  try {
    // ── Sales ─────────────────────────────────────────────────────────────
    const sales = await client.query(`
      SELECT s.sale_id, s.subtotal, s.tax_amount, s.discount_amount,
             s.total_amount, s.payment_method, s.created_at, s.created_by
      FROM sales s ORDER BY s.sale_id`);

    for (const s of sales.rows) {
      if (await gl.entryExists(client, 'sale', s.sale_id)) { skipped++; continue; }
      await client.query('BEGIN');
      try {
        const cogs = await gl.cogsLinesForSale(client, s.sale_id);
        await gl.postEntry(client, {
          date: s.created_at?.toISOString().split('T')[0],
          memo: `POS Sale #${s.sale_id}`,
          sourceType: 'sale', sourceId: s.sale_id, createdBy: s.created_by,
          lines: [
            { systemKey: gl.paymentAccountKey(s.payment_method), debit: parseFloat(s.total_amount),    description: 'Sale received' },
            { systemKey: 'sales_income', credit: parseFloat(s.subtotal),       description: 'Sales revenue' },
            { systemKey: 'sales_tax',    credit: parseFloat(s.tax_amount),     description: 'Sales tax collected' },
            { systemKey: 'discounts',    debit:  parseFloat(s.discount_amount), description: 'Discount given' },
            ...cogs,
          ],
        });
        await client.query('COMMIT');
        console.log(`  ✓ Sale #${s.sale_id}`);
        posted++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`  ✗ Sale #${s.sale_id}: ${e.message}`);
      }
    }

    // ── Bills ─────────────────────────────────────────────────────────────
    const bills = await client.query(`
      SELECT bill_id, bill_number, total_amount, amount_paid,
             po_id, issue_date, created_by FROM bills ORDER BY bill_id`);

    for (const b of bills.rows) {
      if (await gl.entryExists(client, 'bill', b.bill_id)) { skipped++; continue; }
      await client.query('BEGIN');
      try {
        const total = parseFloat(b.total_amount);
        await gl.postEntry(client, {
          date: b.issue_date,
          memo: `Bill ${b.bill_number}`,
          sourceType: 'bill', sourceId: b.bill_id, createdBy: b.created_by,
          lines: [
            { systemKey: b.po_id ? 'inventory' : 'expense_supplies',
              debit: total, description: b.po_id ? 'Inventory received' : 'Bill expense' },
            { systemKey: 'ap', credit: total, description: 'Accounts payable' },
          ],
        });

        // Post payment if any amount has been paid
        const paid = parseFloat(b.amount_paid || 0);
        if (paid > 0 && !(await gl.entryExists(client, 'bill_payment', b.bill_id))) {
          await gl.postEntry(client, {
            date: b.issue_date,
            memo: `Payment — ${b.bill_number}`,
            sourceType: 'bill_payment', sourceId: b.bill_id, createdBy: b.created_by,
            lines: [
              { systemKey: 'ap',   debit: paid, description: 'A/P settled' },
              { systemKey: 'bank', credit: paid, description: 'Supplier payment' },
            ],
          });
        }

        await client.query('COMMIT');
        console.log(`  ✓ Bill ${b.bill_number}`);
        posted++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`  ✗ Bill ${b.bill_number}: ${e.message}`);
      }
    }

    // ── Expenses ──────────────────────────────────────────────────────────
    const expenses = await client.query(`
      SELECT expense_id, expense_number, category, payee,
             payment_method, expense_date, total_amount, created_by
      FROM expenses ORDER BY expense_id`);

    for (const e of expenses.rows) {
      if (await gl.entryExists(client, 'expense', e.expense_id)) { skipped++; continue; }
      await client.query('BEGIN');
      try {
        const total  = parseFloat(e.total_amount);
        const method = e.payment_method || 'cash';
        await gl.postEntry(client, {
          date: e.expense_date,
          memo: `Expense ${e.expense_number} — ${e.category}`,
          sourceType: 'expense', sourceId: e.expense_id, createdBy: e.created_by,
          lines: [
            { expenseCategory: e.category, debit: total, description: e.payee || e.category },
            { systemKey: gl.paymentAccountKey(method), credit: total, description: 'Paid' },
          ],
        });
        await client.query('COMMIT');
        console.log(`  ✓ Expense ${e.expense_number}`);
        posted++;
      } catch (e2) {
        await client.query('ROLLBACK');
        console.error(`  ✗ Expense ${e.expense_number}: ${e2.message}`);
      }
    }

    console.log(`\nBackfill complete: ${posted} posted, ${skipped} skipped (already posted).`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
