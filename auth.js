const crypto = require('crypto');

const tokens = new Map(); // token -> { user, expires }

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  const session = tokens.get(token);
  if (Date.now() > session.expires) { tokens.delete(token); return res.status(401).json({ error: 'Session expired' }); }
  req.user = session.user;
  next();
}

function requirePermission(perm) {
  return function(req, res, next) {
    if (req.user.is_admin) return next();
    if ((req.user.permissions || []).includes(perm)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

module.exports = { tokens, generateToken, requireAuth, requirePermission };
