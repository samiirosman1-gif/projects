const express = require('express');
const pool    = require('../db');
const { verifyToken } = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const router = express.Router();
router.use(verifyToken);

// ── Ensure uploads/staff folder exists ───────────────────────────────────
const staffUploadDir = path.join(__dirname, '../uploads/staff');
if (!fs.existsSync(staffUploadDir)) {
  fs.mkdirSync(staffUploadDir, { recursive: true });
}

// ── Image upload ──────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, staffUploadDir),
  filename:    (req, file, cb) => cb(null, `staff_${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg', '.jpeg', '.png', '.webp'].includes(
      path.extname(file.originalname).toLowerCase()
    );
    if (!ok) return cb(new Error('Only jpg, png and webp images are allowed.'));
    cb(null, true);
  },
});

router.post('/upload-image', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });
    res.json({ image_url: `/uploads/staff/${req.file.filename}` });
  });
});

// ── STAFF CRUD ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, active } = req.query;
    let q = `SELECT * FROM staff WHERE 1=1`;
    const p = [];
    if (search) { p.push(`%${search}%`); q += ` AND (full_name ILIKE $${p.length} OR position ILIKE $${p.length} OR department ILIKE $${p.length})`; }
    if (active !== undefined) { p.push(active === 'true'); q += ` AND is_active = $${p.length}`; }
    q += ` ORDER BY full_name ASC`;
    const result = await pool.query(q, p);
    res.json({ staff: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const s = await pool.query('SELECT * FROM staff WHERE staff_id=$1', [req.params.id]);
    if (!s.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ staff: s.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  const { full_name, position, department, phone, email, address,
    date_of_birth, hire_date, employment_type, salary, hourly_rate,
    image_url, notes } = req.body;
  if (!full_name) return res.status(400).json({ error: 'full_name is required.' });
  try {
    const r = await pool.query(
      `INSERT INTO staff (full_name,position,department,phone,email,address,
        date_of_birth,hire_date,employment_type,salary,hourly_rate,image_url,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [full_name,position,department,phone,email,address,
       date_of_birth||null,hire_date||null,employment_type||'full_time',
       salary||0,hourly_rate||0,image_url||null,notes||null]
    );
    res.status(201).json({ staff: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', async (req, res) => {
  const { full_name, position, department, phone, email, address,
    date_of_birth, hire_date, employment_type, salary, hourly_rate,
    image_url, is_active, notes } = req.body;
  try {
    const r = await pool.query(
      `UPDATE staff SET full_name=COALESCE($1,full_name), position=COALESCE($2,position),
        department=COALESCE($3,department), phone=COALESCE($4,phone),
        email=COALESCE($5,email), address=COALESCE($6,address),
        date_of_birth=COALESCE($7,date_of_birth), hire_date=COALESCE($8,hire_date),
        employment_type=COALESCE($9,employment_type), salary=COALESCE($10,salary),
        hourly_rate=COALESCE($11,hourly_rate), image_url=COALESCE($12,image_url),
        is_active=COALESCE($13,is_active), notes=COALESCE($14,notes),
        updated_at=NOW()
       WHERE staff_id=$15 RETURNING *`,
      [full_name,position,department,phone,email,address,
       date_of_birth,hire_date,employment_type,salary,hourly_rate,
       image_url,is_active,notes,req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ staff: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM staff WHERE staff_id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ATTENDANCE ────────────────────────────────────────────────────────────
router.get('/:id/attendance', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM staff_attendance WHERE staff_id=$1 ORDER BY date DESC LIMIT 60`,
      [req.params.id]
    );
    res.json({ attendance: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/attendance', async (req, res) => {
  const { date, clock_in, clock_out, status, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO staff_attendance(staff_id,date,clock_in,clock_out,status,notes)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, date||new Date().toISOString().split('T')[0],
       clock_in||null, clock_out||null, status||'present', notes||null]
    );
    res.status(201).json({ attendance: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/attendance/:aid', async (req, res) => {
  const { clock_in, clock_out, status, notes } = req.body;
  try {
    const r = await pool.query(
      `UPDATE staff_attendance SET clock_in=COALESCE($1,clock_in),
        clock_out=COALESCE($2,clock_out), status=COALESCE($3,status),
        notes=COALESCE($4,notes) WHERE attendance_id=$5 RETURNING *`,
      [clock_in, clock_out, status, notes, req.params.aid]
    );
    res.json({ attendance: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SHIFTS ────────────────────────────────────────────────────────────────
router.get('/:id/shifts', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM staff_shifts WHERE staff_id=$1 ORDER BY shift_date DESC LIMIT 60`,
      [req.params.id]
    );
    res.json({ shifts: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/shifts', async (req, res) => {
  const { shift_date, start_time, end_time, title, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO staff_shifts(staff_id,shift_date,start_time,end_time,title,notes)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, shift_date, start_time, end_time, title||null, notes||null]
    );
    res.status(201).json({ shift: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/shifts/:sid', async (req, res) => {
  try {
    await pool.query('DELETE FROM staff_shifts WHERE shift_id=$1', [req.params.sid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PAYROLL ───────────────────────────────────────────────────────────────
router.get('/:id/payroll', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM staff_payroll WHERE staff_id=$1 ORDER BY period_start DESC`,
      [req.params.id]
    );
    res.json({ payroll: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/payroll', async (req, res) => {
  const { period_start, period_end, basic_salary, allowances, deductions, notes } = req.body;
  const net = (parseFloat(basic_salary)||0) + (parseFloat(allowances)||0) - (parseFloat(deductions)||0);
  try {
    const r = await pool.query(
      `INSERT INTO staff_payroll(staff_id,period_start,period_end,basic_salary,allowances,deductions,net_pay,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, period_start, period_end,
       basic_salary||0, allowances||0, deductions||0, net, notes||null]
    );
    res.status(201).json({ payroll: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/payroll/:pid', async (req, res) => {
  const { status, paid_at } = req.body;
  try {
    const r = await pool.query(
      `UPDATE staff_payroll SET status=COALESCE($1,status),
        paid_at=COALESCE($2,paid_at) WHERE payroll_id=$3 RETURNING *`,
      [status, paid_at||null, req.params.pid]
    );
    res.json({ payroll: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LEAVE ─────────────────────────────────────────────────────────────────
router.get('/:id/leave', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM staff_leave WHERE staff_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ leave: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/leave', async (req, res) => {
  const { leave_type, start_date, end_date, days, reason } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO staff_leave(staff_id,leave_type,start_date,end_date,days,reason)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, leave_type||'annual', start_date, end_date, days||1, reason||null]
    );
    res.status(201).json({ leave: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/leave/:lid', async (req, res) => {
  const { status } = req.body;
  try {
    const r = await pool.query(
      `UPDATE staff_leave SET status=$1 WHERE leave_id=$2 RETURNING *`,
      [status, req.params.lid]
    );
    res.json({ leave: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DOCUMENTS ─────────────────────────────────────────────────────────────
router.get('/:id/documents', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM staff_documents WHERE staff_id=$1 ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ documents: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/documents', async (req, res) => {
  const { title, document_type, file_url, notes } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO staff_documents(staff_id,title,document_type,file_url,notes)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, title, document_type||'other', file_url||null, notes||null]
    );
    res.status(201).json({ document: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/documents/:did', async (req, res) => {
  try {
    await pool.query('DELETE FROM staff_documents WHERE document_id=$1', [req.params.did]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;