function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '请先登录' });
  }
  res.redirect('/admin/login');
}

function redirectIfAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return res.redirect('/admin/dashboard');
  }
  next();
}

module.exports = { requireAuth, redirectIfAuth };
