const jwt = require('jsonwebtoken');
const pool = require('../db');

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requirePermission(permissionName) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    try {
      const result = await pool.query(
        `SELECT 1
         FROM role_permissions rp
         JOIN roles r ON r.role_id = rp.role_id
         JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE r.role_name = $1 AND p.permission_name = $2`,
        [req.user.role, permissionName]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'You do not have permission to do that.' });
      }

      next();
    } catch (err) {
      console.error('Permission check error:', err);
      res.status(500).json({ error: 'Something went wrong checking permissions.' });
    }
  };
}

module.exports = { verifyToken, requirePermission };