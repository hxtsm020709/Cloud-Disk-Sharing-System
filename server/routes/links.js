const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// 有效期选项
const EXPIRE_OPTIONS = [
  { label: '3 小时', hours: 3 },
  { label: '6 小时', hours: 6 },
  { label: '24 小时', hours: 24 },
  { label: '3 天', hours: 72 },
];

// 分享链接管理页
router.get('/links', requireAuth, (req, res) => {
  const accounts = db.all('SELECT id, nickname FROM accounts WHERE is_deleted = 0 ORDER BY nickname');

  // 清理过期链接
  db.run("UPDATE share_links SET status = 'expired' WHERE status = 'active' AND first_used_at IS NOT NULL AND expire_at <= datetime('now', 'localtime')");

  const search = req.query.search || '';
  const status = req.query.status || '';
  const poolType = req.query.pool || '';

  let sql = `
    SELECT sl.*, a.nickname as account_nickname
    FROM share_links sl
    LEFT JOIN accounts a ON sl.account_id = a.id
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    sql += ' AND (a.nickname LIKE ? OR sl.token LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status === 'pending') {
    sql += " AND sl.status = 'active' AND sl.first_used_at IS NULL";
  } else if (status && status !== 'all') {
    sql += ' AND sl.status = ?';
    params.push(status);
  }
  if (poolType === 'pool') {
    sql += ' AND sl.is_pool = 1';
  } else if (poolType === 'solo') {
    sql += ' AND (sl.is_pool IS NULL OR sl.is_pool = 0)';
  }

  sql += ' ORDER BY sl.created_at DESC';

  const links = db.all(sql, params);

  res.render('links', {
    title: '分享链接管理',
    adminUsername: req.session.adminUsername,
    accounts,
    links,
    expireOptions: EXPIRE_OPTIONS,
    search,
    status,
    poolType,
  });
});

// API: 生成分享链接
router.post('/api/links', requireAuth, (req, res) => {
  const { account_id, expire_hours } = req.body;

  if (!account_id) {
    return res.json({ success: false, message: '请选择账号' });
  }

  const hours = parseInt(expire_hours) || 24;

  const account = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [account_id]);
  if (!account) {
    return res.json({ success: false, message: '账号不存在' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const d = new Date(Date.now() + hours * 3600000);
  const pad = n => String(n).padStart(2, '0');
  const expireAt = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  db.run(
    `INSERT INTO share_links (token, account_id, expire_hours, expire_at) VALUES (?, ?, ?, ?)`,
    [token, account_id, hours, expireAt]
  );

  res.json({
    success: true,
    message: '链接已生成',
    token,
    expireAt,
  });
});

// API: 停用链接
router.post('/api/links/:id/disable', requireAuth, (req, res) => {
  db.run("UPDATE share_links SET status = 'disabled' WHERE id = ?", [req.params.id]);
  res.json({ success: true, message: '链接已停用' });
});

// API: 批量停用链接
router.post('/api/links/batch-disable', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '请选择要停用的链接' });
  }
  const placeholders = ids.map(() => '?').join(',');
  db.run(
    `UPDATE share_links SET status = 'disabled' WHERE id IN (${placeholders}) AND status = 'active'`,
    ids
  );
  res.json({ success: true, message: `已停用 ${ids.length} 条链接` });
});

// API: 一键删除所有已停用/过期链接
router.post('/api/links/delete-all-disabled', requireAuth, (req, res) => {
  db.run(
    "DELETE FROM share_links WHERE status IN ('disabled', 'expired')"
  );
  res.json({ success: true, message: '已清理所有已停用和过期的链接' });
});

// API: 批量删除
router.post('/api/links/batch-delete', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '请选择要删除的链接' });
  }

  const placeholders = ids.map(() => '?').join(',');
  db.run(
    `DELETE FROM share_links WHERE id IN (${placeholders}) AND status != 'active'`,
    ids
  );
  res.json({ success: true, message: `已删除 ${ids.length} 条链接` });
});

function getAccountUsageScore(accountId) {
  const row = db.get(
    "SELECT COALESCE(SUM(use_count), 0) as total FROM share_links WHERE account_id = ? AND is_pool = 1 AND status = 'active'",
    [accountId]
  );
  return row ? row.total : 0;
}

async function pickLeastUsedAccount(excludeAccountIds = []) {
  const { checkCookieValid } = require('../services/baidu-auth');
  const { decrypt } = require('../utils/crypto');

  const allAccounts = db.all('SELECT * FROM accounts WHERE is_deleted = 0 AND is_paused = 0');
  const excludeSet = new Set(excludeAccountIds);
  let best = null;
  let bestScore = Infinity;

  for (const acc of allAccounts) {
    if (excludeSet.has(acc.id)) continue;
    try {
      const cookie = decrypt(acc.cookie_encrypted);
      const check = await checkCookieValid(cookie);
      if (check.valid) {
        db.run(
          `UPDATE accounts SET cookie_status='valid', vip_type=?, cookie_updated_at=datetime('now','localtime') WHERE id=?`,
          [check.vipType || acc.vip_type, acc.id]
        );
        const score = getAccountUsageScore(acc.id);
        if (score < bestScore) {
          bestScore = score;
          best = { account: acc, vipType: check.vipType, score };
        }
      } else {
        db.run(
          `UPDATE accounts SET cookie_status='expired', cookie_updated_at=datetime('now','localtime') WHERE id=?`,
          [acc.id]
        );
      }
    } catch(e) { /* skip */ }
  }

  return best;
}

async function reassignPoolLinksForAccount(accountId) {
  const activeLinks = db.all(
    "SELECT * FROM share_links WHERE account_id = ? AND is_pool = 1 AND status = 'active'",
    [accountId]
  );
  if (activeLinks.length === 0) return { reassigned: 0, failed: 0, details: [] };

  const details = [];
  let reassigned = 0;
  let failed = 0;
  const excludeIds = [accountId];

  for (const link of activeLinks) {
    const best = await pickLeastUsedAccount(excludeIds);
    if (best) {
      db.run('UPDATE share_links SET account_id = ? WHERE id = ?', [best.account.id, link.id]);
      excludeIds.push(best.account.id);
      reassigned++;
      details.push({
        linkId: link.id,
        token: link.token,
        oldAccountId: accountId,
        newAccountId: best.account.id,
        newAccountName: best.account.nickname,
        newAccountScore: best.score,
      });
    } else {
      failed++;
      details.push({ linkId: link.id, token: link.token, error: '没有可用账号' });
    }
  }

  return { reassigned, failed, details };
}

// API: 生成单个分享池链接
router.post('/api/links/pool', requireAuth, async (req, res) => {
  const { expire_hours } = req.body;
  const hours = parseInt(expire_hours) || 24;

  const best = await pickLeastUsedAccount();
  if (!best) {
    return res.json({ success: false, message: '没有可用的有效账号，请先添加有效 Cookie' });
  }

  const d = new Date(Date.now() + hours * 3600000);
  const pad = n => String(n).padStart(2, '0');
  const expireAt = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const token = crypto.randomBytes(12).toString('hex');
  db.run(
    `INSERT INTO share_links (token, account_id, expire_hours, expire_at, max_uses, is_pool) VALUES (?, ?, ?, ?, 20, 1)`,
    [token, best.account.id, hours, expireAt]
  );

  res.json({
    success: true,
    message: `已生成分享池链接（账号: ${best.account.nickname}，当前负载 ${best.score} 次，${hours}h 有效）`,
    token: { token, accountId: best.account.id, accountName: best.account.nickname, vipType: best.vipType, score: best.score },
    expireAt,
  });
});

// API: 批量生成分享池链接
router.post('/api/links/batch-pool', requireAuth, async (req, res) => {
  const { expire_hours, count } = req.body;
  const hours = parseInt(expire_hours) || 24;
  const batchCount = Math.min(parseInt(count) || 1, 50);

  const d = new Date(Date.now() + hours * 3600000);
  const pad = n => String(n).padStart(2, '0');
  const expireAt = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const tokens = [];
  const usedScores = {};

  for (let i = 0; i < batchCount; i++) {
    let best = await pickLeastUsedAccount([]);
    if (best) {
      const tempScore = usedScores[best.account.id] || 0;
      best.score = best.score + tempScore;
      if (tempScore > 0) {
        const allAccounts = db.all('SELECT * FROM accounts WHERE is_deleted = 0 AND is_paused = 0');
        let bestAcc = null;
        let bestBalancedScore = Infinity;
        const { checkCookieValid } = require('../services/baidu-auth');
        const { decrypt } = require('../utils/crypto');
        for (const acc of allAccounts) {
          try {
            const cookie = decrypt(acc.cookie_encrypted);
            const check = await checkCookieValid(cookie);
            if (check.valid) {
              const baseScore = getAccountUsageScore(acc.id);
              const temp = usedScores[acc.id] || 0;
              const balanced = baseScore + temp;
              if (balanced < bestBalancedScore) {
                bestBalancedScore = balanced;
                bestAcc = { account: acc, vipType: check.vipType, score: baseScore };
              }
            }
          } catch(e) {}
        }
        if (bestAcc) best = bestAcc;
      }
    }

    if (!best) break;

    usedScores[best.account.id] = (usedScores[best.account.id] || 0) + 1;

    const token = crypto.randomBytes(12).toString('hex');
    db.run(
      `INSERT INTO share_links (token, account_id, expire_hours, expire_at, max_uses, is_pool) VALUES (?, ?, ?, ?, 20, 1)`,
      [token, best.account.id, hours, expireAt]
    );
    tokens.push({ token, accountId: best.account.id, accountName: best.account.nickname, vipType: best.vipType, score: best.score });
  }

  res.json({
    success: true,
    message: `已生成 ${tokens.length} 个分享池链接`,
    tokens,
    expireAt,
  });
});

// API: 分享池 — 自动切换链接的账号
router.post('/api/links/:id/rotate-account', requireAuth, async (req, res) => {
  const { checkCookieValid } = require('../services/baidu-auth');
  const { decrypt } = require('../utils/crypto');

  const linkId = req.params.id;
  const link = db.get('SELECT * FROM share_links WHERE id = ? AND status = \'active\'', [linkId]);
  if (!link) return res.json({ success: false, message: '链接不存在或已失效' });

  const currentAccount = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [link.account_id]);
  if (currentAccount) {
    try {
      const cookie = decrypt(currentAccount.cookie_encrypted);
      const check = await checkCookieValid(cookie);
      if (check.valid) {
        return res.json({ success: true, rotated: false, message: '当前账号 Cookie 仍然有效' });
      }
      db.run(`UPDATE accounts SET cookie_status='expired', cookie_updated_at=datetime('now','localtime') WHERE id=?`, [currentAccount.id]);
    } catch(e) {}
  }

  const allAccounts = db.all('SELECT * FROM accounts WHERE is_deleted = 0 AND is_paused = 0 AND id != ?', [link.account_id]);
  for (const acc of allAccounts) {
    try {
      const cookie = decrypt(acc.cookie_encrypted);
      const check = await checkCookieValid(cookie);
      if (check.valid) {
        db.run(`UPDATE accounts SET cookie_status='valid', vip_type=?, cookie_updated_at=datetime('now','localtime') WHERE id=?`, [check.vipType || acc.vip_type, acc.id]);
        db.run('UPDATE share_links SET account_id = ? WHERE id = ?', [acc.id, linkId]);
        return res.json({ success: true, rotated: true, newAccountId: acc.id, newAccountName: acc.nickname, vipType: check.vipType });
      } else {
        db.run(`UPDATE accounts SET cookie_status='expired', cookie_updated_at=datetime('now','localtime') WHERE id=?`, [acc.id]);
      }
    } catch(e) {}
  }

  res.json({ success: false, message: '没有其他可用账号，所有 Cookie 均已失效' });
});

// API: 导出链接（CSV / TXT）
router.get('/api/links/export', requireAuth, (req, res) => {
  const status = req.query.status || '';
  const format = req.query.format || 'csv';

  let sql = `
    SELECT sl.token, a.nickname, sl.is_pool, sl.first_used_at, sl.expire_hours, sl.expire_at,
           sl.use_count, sl.max_uses, sl.status, sl.created_at
    FROM share_links sl
    LEFT JOIN accounts a ON sl.account_id = a.id
    WHERE 1=1
  `;
  const params = [];

  if (status === 'pending') {
    sql += " AND sl.status = 'active' AND sl.first_used_at IS NULL";
  } else if (status && status !== 'all') {
    sql += ' AND sl.status = ?';
    params.push(status);
  }

  sql += ' ORDER BY sl.created_at DESC';

  const links = db.all(sql, params);

  if (format === 'txt') {
    const lines = links.map(l => `https://yunpan.up.railway.app/s/${l.token}`);
    const txt = lines.join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="links_export_${Date.now()}.txt"`);
    res.send(txt);
    return;
  }

  const BOM = '﻿';
  const header = '链接地址,账号,类型,有效期(小时),到期时间,使用次数,最大次数,状态,创建时间';
  const rows = links.map(l => {
    const url = `https://yunpan.up.railway.app/s/${l.token}`;
    const type = l.is_pool === 1 ? '分享池' : '独享';
    const isPending = l.first_used_at === null && l.status === 'active';
    const statusMap = { active: '有效', expired: '已过期', disabled: '已停用' };
    const statusName = isPending ? '待使用' : (statusMap[l.status] || l.status);
    return [url, l.nickname || '', type, l.expire_hours, l.expire_at || '', l.use_count, l.max_uses || 20, statusName, l.created_at || '']
      .map(v => '"' + String(v).replace(/"/g, '""') + '"')
      .join(',');
  });

  const csv = BOM + header + '\n' + rows.join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="links_export_${Date.now()}.csv"`);
  res.send(csv);
});

// API: 账号池统计（仪表盘用）
router.get('/api/links/pool-stats', requireAuth, async (req, res) => {
  const accounts = db.all('SELECT id, nickname, vip_type, cookie_status FROM accounts WHERE is_deleted = 0 ORDER BY nickname');

  const stats = [];
  for (const acc of accounts) {
    const usageScore = getAccountUsageScore(acc.id);
    const activePoolLinks = db.all(
      "SELECT id, token, use_count, created_at FROM share_links WHERE account_id = ? AND is_pool = 1 AND status = 'active' ORDER BY use_count DESC",
      [acc.id]
    );
    stats.push({
      id: acc.id,
      nickname: acc.nickname,
      vipType: acc.vip_type,
      cookieStatus: acc.cookie_status,
      usageScore,
      activeLinkCount: activePoolLinks.length,
      links: activePoolLinks,
    });
  }

  stats.sort((a, b) => a.usageScore - b.usageScore);

  const totalLinks = db.get("SELECT COUNT(*) as count FROM share_links WHERE is_pool = 1 AND status = 'active'");
  const totalUsage = db.get("SELECT COALESCE(SUM(use_count), 0) as total FROM share_links WHERE is_pool = 1 AND status = 'active'");

  res.json({
    success: true,
    accounts: stats,
    summary: {
      totalAccounts: accounts.length,
      validAccounts: accounts.filter(a => a.cookie_status === 'valid').length,
      totalActiveLinks: totalLinks ? totalLinks.count : 0,
      totalUsage: totalUsage ? totalUsage.total : 0,
    },
  });
});

module.exports = { router, EXPIRE_OPTIONS, getAccountUsageScore, pickLeastUsedAccount, reassignPoolLinksForAccount };
