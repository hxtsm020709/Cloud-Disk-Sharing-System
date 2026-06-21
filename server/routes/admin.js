const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../database');
const { requireAuth, redirectIfAuth } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

// 确保默认管理员账号存在
function ensureAdmin() {
  const existing = db.get('SELECT * FROM admins WHERE username = ?', [config.adminUser]);
  if (!existing) {
    const hash = bcrypt.hashSync(config.adminPass, 10);
    db.run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [config.adminUser, hash]);
    console.log('默认管理员账号已创建:', config.adminUser, '/', config.adminPass);
  }
}

// 登录页面
router.get('/login', redirectIfAuth, (req, res) => {
  res.render('login', {
    title: '管理员登录',
    error: null,
    layout: false,
  });
});

// 处理登录
router.post('/login', redirectIfAuth, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('login', {
      title: '管理员登录',
      error: '请输入用户名和密码',
      layout: false,
    });
  }

  const admin = db.get('SELECT * FROM admins WHERE username = ?', [username]);
  if (!admin) {
    return res.render('login', {
      title: '管理员登录',
      error: '用户名或密码错误',
      layout: false,
    });
  }

  const valid = bcrypt.compareSync(password, admin.password_hash);
  if (!valid) {
    return res.render('login', {
      title: '管理员登录',
      error: '用户名或密码错误',
      layout: false,
    });
  }

  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  res.redirect('/admin/dashboard');
});

// 退出登录
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// 仪表盘（需要登录）
router.get('/dashboard', requireAuth, (req, res) => {
  const accountCount = db.get('SELECT COUNT(*) as count FROM accounts WHERE is_deleted = 0');
  const activeLinks = db.get("SELECT COUNT(*) as count FROM share_links WHERE status = 'active' AND expire_at > datetime('now', 'localtime')");
  const validCookies = db.get("SELECT COUNT(*) as count FROM accounts WHERE is_deleted = 0 AND cookie_status = 'valid'");
  const expiredCookies = db.get("SELECT COUNT(*) as count FROM accounts WHERE is_deleted = 0 AND cookie_status = 'expired'");
  const expiringAccounts = db.all(
    "SELECT * FROM accounts WHERE is_deleted = 0 AND vip_expire_date IS NOT NULL AND vip_expire_date <= date('now', '+7 days') ORDER BY vip_expire_date ASC"
  );

  // 账号列表（仪表盘内嵌）
  const accounts = db.all('SELECT * FROM accounts WHERE is_deleted = 0 ORDER BY updated_at DESC');
  // 清理过期链接 + 查询
  db.run("UPDATE share_links SET status = 'expired' WHERE status = 'active' AND first_used_at IS NOT NULL AND expire_at <= datetime('now', 'localtime')");
  const links = db.all(`
    SELECT sl.*, a.nickname as account_nickname
    FROM share_links sl
    LEFT JOIN accounts a ON sl.account_id = a.id
    ORDER BY sl.created_at DESC
    LIMIT 20
  `);

  // 账号池统计
  const poolStats = [];
  for (const acc of accounts) {
    const usageScore = db.get(
      "SELECT COALESCE(SUM(use_count), 0) as total FROM share_links WHERE account_id = ? AND is_pool = 1 AND status = 'active'",
      [acc.id]
    );
    const activePoolLinkCount = db.get(
      "SELECT COUNT(*) as count FROM share_links WHERE account_id = ? AND is_pool = 1 AND status = 'active'",
      [acc.id]
    );
    poolStats.push({
      id: acc.id,
      nickname: acc.nickname,
      vipType: acc.vip_type,
      cookieStatus: acc.cookie_status,
      isPaused: !!acc.is_paused,
      usageScore: usageScore ? usageScore.total : 0,
      activePoolLinks: activePoolLinkCount ? activePoolLinkCount.count : 0,
    });
  }
  poolStats.sort((a, b) => a.usageScore - b.usageScore);
  const maxUsage = Math.max(1, ...poolStats.map(s => s.usageScore));

  const totalPoolLinks = db.get("SELECT COUNT(*) as count FROM share_links WHERE is_pool = 1 AND status = 'active'");
  const totalPoolUsage = db.get("SELECT COALESCE(SUM(use_count), 0) as total FROM share_links WHERE is_pool = 1 AND status = 'active'");

  const EXPIRE_OPTIONS = [
    { label: '3 小时', hours: 3 },
    { label: '6 小时', hours: 6 },
    { label: '24 小时', hours: 24 },
    { label: '3 天', hours: 72 },
  ];

  res.render('dashboard', {
    title: '管理后台',
    adminUsername: req.session.adminUsername,
    stats: {
      totalAccounts: accountCount ? accountCount.count : 0,
      activeLinks: activeLinks ? activeLinks.count : 0,
      expiringCount: expiringAccounts.length,
      validCookies: validCookies ? validCookies.count : 0,
      expiredCookies: expiredCookies ? expiredCookies.count : 0,
    },
    expiringAccounts,
    accounts,
    links,
    expireOptions: EXPIRE_OPTIONS,
    poolStats,
    maxUsage,
    totalPoolLinks: totalPoolLinks ? totalPoolLinks.count : 0,
    totalPoolUsage: totalPoolUsage ? totalPoolUsage.total : 0,
  });
});

// API: 修改密码
router.post('/api/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 6) {
    return res.json({ success: false, message: '新密码至少6位' });
  }

  const admin = db.get('SELECT * FROM admins WHERE id = ?', [req.session.adminId]);
  const valid = bcrypt.compareSync(oldPassword, admin.password_hash);
  if (!valid) {
    return res.json({ success: false, message: '原密码错误' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, req.session.adminId]);
  res.json({ success: true, message: '密码修改成功' });
});

// 设置页面
router.get('/settings', requireAuth, (req, res) => {
  const settings = db.getAllSettings();
  res.render('settings', {
    title: '系统设置',
    adminUsername: req.session.adminUsername,
    settings,
    success: null,
  });
});

// API: 保存设置
router.post('/api/settings', requireAuth, (req, res) => {
  const { tutorial_android, tutorial_pc, tutorial_apple, tips_content } = req.body;
  if (tutorial_android !== undefined) db.setSetting('tutorial_android', tutorial_android);
  if (tutorial_pc !== undefined) db.setSetting('tutorial_pc', tutorial_pc);
  if (tutorial_apple !== undefined) db.setSetting('tutorial_apple', tutorial_apple);
  if (tips_content !== undefined) db.setSetting('tips_content', tips_content || '');

  res.json({ success: true, message: '设置已保存' });
});

module.exports = { router, ensureAdmin };
