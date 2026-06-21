const express = require('express');
const db = require('../database');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt, maskPhone, maskCookie } = require('../utils/crypto');
const { requestQRCode, pollQRStatus } = require('../services/baidu-auth');

const router = express.Router();

// 账号列表页
router.get('/accounts', requireAuth, (req, res) => {
  const search = req.query.search || '';
  const status = req.query.status || '';

  let sql = 'SELECT * FROM accounts WHERE is_deleted = 0';
  const params = [];

  if (search) {
    sql += ' AND (nickname LIKE ? OR phone LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status && status !== 'all') {
    sql += ' AND cookie_status = ?';
    params.push(status);
  }

  sql += ' ORDER BY updated_at DESC';

  const accounts = db.all(sql, params);

  res.render('accounts', {
    title: '账号管理',
    adminUsername: req.session.adminUsername,
    accounts,
    search,
    status,
    maskPhone,
  });
});

// 添加账号页面
router.get('/accounts/add', requireAuth, (req, res) => {
  res.render('add-account', {
    title: '添加账号',
    adminUsername: req.session.adminUsername,
    error: null,
    success: null,
  });
});

// API: 创建账号
router.post('/api/accounts', requireAuth, async (req, res) => {
  try {
    const { nickname, phone, vip_type, vip_expire_date, cookie_text, notes } = req.body;

    if (!cookie_text || !notes) {
      return res.json({ success: false, message: 'Cookie 和备注为必填项' });
    }

    const cookieEncrypted = encrypt(cookie_text.trim());

    db.run(
      `INSERT INTO accounts (nickname, phone, vip_type, vip_expire_date, cookie_encrypted, cookie_status, cookie_updated_at, notes)
       VALUES (?, ?, ?, ?, ?, 'unknown', datetime('now', 'localtime'), ?)`,
      [nickname?.trim() || '未命名', phone || null, vip_type || null, vip_expire_date || null, cookieEncrypted, notes.trim()]
    );

    const lastId = db.get('SELECT last_insert_rowid() as id');
    const accountId = lastId?.id;

    // 自动抓取账号信息
    let autoResult = null;
    try {
      autoResult = await fetchAndSaveAccountInfo(accountId, cookie_text.trim());
    } catch (e) {
      console.error('[api/accounts] fetchAndSave failed:', e.message);
    }

    res.json({
      success: true,
      message: '账号添加成功' + (autoResult ? '' : '（自动检测未完成，可稍后手动抓取）'),
      accountId,
      cookieStatus: autoResult ? (autoResult.valid ? 'valid' : 'expired') : 'unknown',
      cookieMsg: autoResult ? (autoResult.valid ? '有效' : '已过期') : null,
      vipType: autoResult ? autoResult.vipType : null,
      expireDate: autoResult ? autoResult.expireDate : null,
      nickname: autoResult ? autoResult.nickname : null,
    });
  } catch (e) {
    console.error('[api/accounts] 500 error:', e.message, e.stack);
    res.status(500).json({ success: false, message: '服务器错误: ' + e.message });
  }
});

// 账号详情页
router.get('/accounts/:id', requireAuth, (req, res) => {
  const account = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [req.params.id]);
  if (!account) {
    return res.status(404).render('error', { title: '404', message: '账号不存在' });
  }

  let cookiePreview = '', cookieFull = '';
  try {
    const plain = decrypt(account.cookie_encrypted);
    cookiePreview = maskCookie(plain);
    cookieFull = plain;
  } catch (e) {
    cookiePreview = '解密失败';
  }

  const logs = db.all(
    'SELECT * FROM usage_logs WHERE account_id = ? ORDER BY created_at DESC LIMIT 20',
    [account.id]
  );

  res.render('account-detail', {
    title: '账号详情',
    adminUsername: req.session.adminUsername,
    account,
    cookiePreview,
    cookieFull,
    logs,
    error: null,
    success: null,
  });
});

// API: 批量检测所有账号 Cookie 有效性（必须在 :id 路由前注册）
router.post('/api/accounts/check-all-cookies', requireAuth, async (req, res) => {
  const { checkCookieValid, fetchVipInfo } = require('../services/baidu-auth');

  const accounts = db.all('SELECT * FROM accounts WHERE is_deleted = 0');
  const results = [];

  for (const account of accounts) {
    let cookieText;
    try { cookieText = decrypt(account.cookie_encrypted); }
    catch (e) {
      results.push({ id: account.id, nickname: account.nickname, valid: false, error: '解密失败' });
      continue;
    }

    const [checkResult, vipResult] = await Promise.all([
      checkCookieValid(cookieText),
      fetchVipInfo(cookieText),
    ]);
    const vipType = vipResult.vipType || checkResult.vipType;
    const newStatus = checkResult.valid ? 'valid' : 'expired';

    db.run(
      `UPDATE accounts SET cookie_status = ?, vip_type = ?, vip_expire_date = ?, cookie_updated_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [newStatus, vipType || 'normal', vipResult.expireDate || account.vip_expire_date, account.id]
    );

    results.push({
      id: account.id,
      nickname: account.nickname,
      valid: checkResult.valid,
      username: vipResult.nickname || checkResult.username,
      vipType: vipType,
      expireDate: vipResult.expireDate,
      raw: checkResult.raw,
    });
  }

  // 对检测到 Cookie 过期的账号，主动给关联池链接换账号
  const { reassignPoolLinksForAccount } = require('./links');
  let totalReassigned = 0;
  for (const r of results) {
    if (!r.valid) {
      const reassignResult = await reassignPoolLinksForAccount(r.id);
      totalReassigned += reassignResult.reassigned;
      if (reassignResult.reassigned > 0) {
        r.reassignedLinks = reassignResult.reassigned;
      }
    }
  }

  res.json({ success: true, results, poolLinksReassigned: totalReassigned });
});

// API: 批量抓取所有账号会员信息（必须在 :id 路由前注册）
router.post('/api/accounts/fetch-all-vip', requireAuth, async (req, res) => {
  const { fetchVipInfo } = require('../services/baidu-auth');

  const accounts = db.all('SELECT * FROM accounts WHERE is_deleted = 0');
  const results = [];
  let updatedCount = 0;

  for (const account of accounts) {
    let cookieText;
    try { cookieText = decrypt(account.cookie_encrypted); }
    catch (e) {
      results.push({ id: account.id, nickname: account.nickname, ok: false, error: '解密失败' });
      continue;
    }

    try {
      const vipResult = await fetchVipInfo(cookieText);

      if (vipResult.vipType || vipResult.expireDate || vipResult.nickname) {
        db.run(
          `UPDATE accounts SET vip_type = ?, vip_expire_date = ?, nickname = COALESCE(NULLIF(?, ''), nickname), updated_at = datetime('now', 'localtime') WHERE id = ?`,
          [vipResult.vipType || account.vip_type || 'normal', vipResult.expireDate || account.vip_expire_date, vipResult.nickname || '', account.id]
        );
        updatedCount++;
      }

      results.push({
        id: account.id,
        nickname: vipResult.nickname || account.nickname,
        vipType: vipResult.vipType || account.vip_type,
        expireDate: vipResult.expireDate || account.vip_expire_date,
        ok: true,
      });
    } catch (e) {
      results.push({ id: account.id, nickname: account.nickname, ok: false, error: e.message });
    }
  }

  res.json({ success: true, updatedCount, total: accounts.length, results });
});

// API: 扫码提取保存账号（必须在 :id 路由前注册）
router.post('/api/accounts/from-scan', requireAuth, async (req, res) => {
  const { cookie_text } = req.body;
  if (!cookie_text) {
    return res.json({ success: false, message: '未获取到 Cookie 数据' });
  }

  const cookieEncrypted = encrypt(cookie_text.trim());

  // 先创建账号（状态待检测）
  db.run(
    `INSERT INTO accounts (nickname, vip_type, cookie_encrypted, cookie_status, cookie_updated_at, notes)
     VALUES (?, ?, ?, 'unknown', datetime('now', 'localtime'), ?)`,
    ['扫码导入', 'normal', cookieEncrypted, '扫码导入']
  );

  const lastId = db.get('SELECT last_insert_rowid() as id');
  const accountId = lastId?.id;

  // 自动抓取账号信息
  let autoResult = null;
  try {
    autoResult = await fetchAndSaveAccountInfo(accountId, cookie_text.trim());
  } catch (e) {
    console.error('[api/accounts/from-scan] fetchAndSave failed:', e.message);
  }

  res.json({
    success: true,
    message: '账号添加成功' + (autoResult ? '' : '（自动检测未完成）'),
    accountId,
    nickname: autoResult ? autoResult.nickname : '扫码导入',
    vipType: autoResult ? autoResult.vipType : 'normal',
    cookieStatus: autoResult ? (autoResult.valid ? 'valid' : 'expired') : 'unknown',
  });
});

// API: 批量删除账号（必须在 :id 路由前注册）
router.post('/api/accounts/batch-delete', requireAuth, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '请选择要删除的账号' });
  }

  const { reassignPoolLinksForAccount } = require('./links');

  let totalReassigned = 0;
  let totalFailed = 0;
  let totalOrphanSolo = 0;

  for (const accountId of ids) {
    // 检查关联链接
    const activePoolLinks = db.all(
      "SELECT id FROM share_links WHERE account_id = ? AND is_pool = 1 AND status = 'active'",
      [accountId]
    );
    const activeSoloLinks = db.all(
      "SELECT id FROM share_links WHERE account_id = ? AND (is_pool IS NULL OR is_pool = 0) AND status = 'active'",
      [accountId]
    );

    if (activePoolLinks.length > 0) {
      const result = await reassignPoolLinksForAccount(accountId);
      totalReassigned += result.reassigned;
      totalFailed += result.failed;
    }
    totalOrphanSolo += activeSoloLinks.length;
  }

  const placeholders = ids.map(() => '?').join(',');
  db.run(
    `UPDATE accounts SET is_deleted = 1, updated_at = datetime('now', 'localtime') WHERE id IN (${placeholders})`,
    ids
  );

  const msgParts = [`已删除 ${ids.length} 个账号`];
  if (totalReassigned > 0) msgParts.push(`${totalReassigned} 个池链接已切换`);
  if (totalFailed > 0) msgParts.push(`${totalFailed} 个链接无可用账号`);
  if (totalOrphanSolo > 0) msgParts.push(`${totalOrphanSolo} 个独享链接将失效`);

  res.json({ success: true, message: msgParts.join('；') });
});

// API: 更新账号
router.post('/api/accounts/:id', requireAuth, (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.json({ success: false, message: '无效的请求' });
  }
  const { nickname, phone, vip_type, vip_expire_date, notes } = req.body;
  const accountId = req.params.id;

  const existing = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [accountId]);
  if (!existing) {
    return res.json({ success: false, message: '账号不存在' });
  }

  db.run(
    `UPDATE accounts SET nickname = ?, phone = ?, vip_type = ?, vip_expire_date = ?, notes = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
    [nickname.trim(), phone || null, vip_type || null, vip_expire_date || null, notes || null, accountId]
  );

  res.json({ success: true, message: '账号信息已更新' });
});

// API: 更新 Cookie
router.post('/api/accounts/:id/cookie', requireAuth, (req, res) => {
  const { cookie_text } = req.body;
  const accountId = req.params.id;

  if (!cookie_text) {
    return res.json({ success: false, message: 'Cookie 不能为空' });
  }

  const existing = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [accountId]);
  if (!existing) {
    return res.json({ success: false, message: '账号不存在' });
  }

  const cookieEncrypted = encrypt(cookie_text.trim());
  db.run(
    `UPDATE accounts SET cookie_encrypted = ?, cookie_status = 'unknown', cookie_updated_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id = ?`,
    [cookieEncrypted, accountId]
  );

  res.json({ success: true, message: 'Cookie 已更新' });
});

/**
 * 抓取并保存单个账号信息（Cookie有效性 + 会员信息 + 昵称）
 * 被 POST /api/accounts、from-scan、check-cookie 共用
 */
async function fetchAndSaveAccountInfo(accountId, cookieText) {
  const { checkCookieValid, fetchVipInfo } = require('../services/baidu-auth');

  const [validResult, vipResult] = await Promise.all([
    checkCookieValid(cookieText),
    fetchVipInfo(cookieText),
  ]);

  const vipType = vipResult.vipType || validResult.vipType || '';
  const expireDate = vipResult.expireDate || validResult.expireDate || '';
  const nickname = vipResult.nickname || validResult.username || '';
  const newStatus = validResult.valid ? 'valid' : 'expired';

  // 只更新有值的字段，避免空值覆盖已有数据
  const setClauses = ["cookie_status = ?", "cookie_updated_at = datetime('now', 'localtime')", "updated_at = datetime('now', 'localtime')"];
  const params = [newStatus];
  if (vipType) { setClauses.push('vip_type = ?'); params.push(vipType); }
  if (expireDate) { setClauses.push('vip_expire_date = ?'); params.push(expireDate); }
  if (nickname) { setClauses.push('nickname = ?'); params.push(nickname); }
  params.push(accountId);

  db.run(`UPDATE accounts SET ${setClauses.join(', ')} WHERE id = ?`, params);

  return { valid: validResult.valid, nickname: nickname || null, vipType: vipType || null, expireDate: expireDate || null, raw: validResult.raw };
}

// API: 删除账号（软删除）— 自动重新分配关联的池链接
router.post('/api/accounts/:id/delete', requireAuth, async (req, res) => {
  const accountId = parseInt(req.params.id);

  const account = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [accountId]);
  if (!account) return res.json({ success: false, message: '账号不存在' });

  // 检查关联的活跃链接
  const activePoolLinks = db.all(
    "SELECT id, token FROM share_links WHERE account_id = ? AND is_pool = 1 AND status = 'active'",
    [accountId]
  );
  const activeSoloLinks = db.all(
    "SELECT id, token FROM share_links WHERE account_id = ? AND (is_pool IS NULL OR is_pool = 0) AND status = 'active'",
    [accountId]
  );

  // 重新分配池链接
  let reassignResult = { reassigned: 0, failed: 0, details: [] };
  if (activePoolLinks.length > 0) {
    const { reassignPoolLinksForAccount } = require('./links');
    reassignResult = await reassignPoolLinksForAccount(accountId);
  }

  // 软删除账号
  db.run("UPDATE accounts SET is_deleted = 1, updated_at = datetime('now', 'localtime') WHERE id = ?", [accountId]);

  const msgParts = ['账号已删除'];
  if (reassignResult.reassigned > 0) {
    msgParts.push(`${reassignResult.reassigned} 个关联池链接已自动切换到其他账号`);
  }
  if (reassignResult.failed > 0) {
    msgParts.push(`${reassignResult.failed} 个链接无可用账号替换`);
  }
  if (activeSoloLinks.length > 0) {
    msgParts.push(`${activeSoloLinks.length} 个独享链接将失效`);
  }

  res.json({
    success: true,
    message: msgParts.join('；'),
    reassigned: reassignResult.reassigned,
    failedReassign: reassignResult.failed,
    orphanSoloLinks: activeSoloLinks.length,
    details: reassignResult.details,
  });
});

// API: 查询账号关联的活跃链接数（删除前预检）
router.get('/api/accounts/:id/dependent-links', requireAuth, (req, res) => {
  const accountId = parseInt(req.params.id);
  const poolLinks = db.all(
    "SELECT id, token FROM share_links WHERE account_id = ? AND is_pool = 1 AND status = 'active'",
    [accountId]
  );
  const soloLinks = db.all(
    "SELECT id, token FROM share_links WHERE account_id = ? AND (is_pool IS NULL OR is_pool = 0) AND status = 'active'",
    [accountId]
  );
  res.json({
    poolCount: poolLinks.length,
    soloCount: soloLinks.length,
    hasDependents: poolLinks.length > 0 || soloLinks.length > 0,
  });
});

// API: 暂停/恢复账号（暂停后不再分配至共享链接，并自动切换关联的共享链接）
router.post('/api/accounts/:id/toggle-pause', requireAuth, async (req, res) => {
  const accountId = parseInt(req.params.id);
  const account = db.get('SELECT id, nickname, is_paused FROM accounts WHERE id = ? AND is_deleted = 0', [accountId]);
  if (!account) return res.json({ success: false, message: '账号不存在' });

  const newState = account.is_paused ? 0 : 1;
  db.run('UPDATE accounts SET is_paused = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?', [newState, accountId]);

  let msg = newState === 1 ? `已暂停「${account.nickname}」，共享链接不再分配此账号` : `已恢复「${account.nickname}」，共享链接可正常分配`;

  // 暂停时自动将关联的共享链接切换到其他可用账号
  if (newState === 1) {
    const { reassignPoolLinksForAccount } = require('./links');
    const reassignResult = await reassignPoolLinksForAccount(accountId);
    if (reassignResult.reassigned > 0) {
      msg += `，${reassignResult.reassigned} 个关联共享链接已自动切换`;
    }
    if (reassignResult.failed > 0) {
      msg += `，${reassignResult.failed} 个链接无可用账号可切换`;
    }
  }

  res.json({ success: true, isPaused: newState === 1, message: msg });
});

// API: 检测单个账号 Cookie 有效性（即详情页的"抓取账号信息"）
router.post('/api/accounts/:id/check-cookie', requireAuth, async (req, res) => {
  const accountId = req.params.id;

  const account = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [accountId]);
  if (!account) return res.json({ success: false, message: '账号不存在' });

  let cookieText;
  try { cookieText = decrypt(account.cookie_encrypted); }
  catch (e) { return res.json({ success: false, message: 'Cookie 解密失败' }); }

  try {
    const result = await fetchAndSaveAccountInfo(accountId, cookieText);

    // Cookie 过期时主动给关联池链接换账号
    let reassignedCount = 0;
    if (!result.valid) {
      const { reassignPoolLinksForAccount } = require('./links');
      const reassignResult = await reassignPoolLinksForAccount(accountId);
      reassignedCount = reassignResult.reassigned;
    }

    res.json({ success: true, result, poolLinksReassigned: reassignedCount });
  } catch (e) {
    console.error('[check-cookie]', e.message);
    res.json({ success: false, message: '抓取失败: ' + e.message });
  }
});

// 存储扫码提取的会话状态（服务端内存）
const scanSessions = new Map(); // sign → { sessionCookies, gid, createdAt }

// API: 请求生成二维码
router.post('/api/qrcode/request', requireAuth, async (req, res) => {
  const result = await requestQRCode();
  if (result.success && result.sign) {
    // 将百度下发的会话 Cookie 和 gid 存起来，轮询时回传
    scanSessions.set(result.sign, {
      sessionCookies: result.sessionCookies || '',
      gid: result.gid || '',
      createdAt: Date.now(),
    });
  }
  res.json(result);
});

// 代理百度二维码图片（带 Cookie 回传）
router.get('/api/qrcode/img', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  try {
    const https = require('https');
    const http = require('http');
    let fullUrl;
    if (url.startsWith('http')) {
      fullUrl = url;
    } else if (url.startsWith('//')) {
      fullUrl = 'https:' + url;
    } else {
      fullUrl = 'https://' + url;
    }
    const parsedUrl = new URL(fullUrl);
    const mod = parsedUrl.protocol === 'https:' ? https : http;

    mod.get(fullUrl, {
      headers: {
        'Referer': 'https://pan.baidu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, (imgRes) => {
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        const loc = imgRes.headers.location;
        const redirectUrl = loc.startsWith('http') ? loc : (parsedUrl.protocol + '//' + parsedUrl.host + loc);
        const redirectParsed = new URL(redirectUrl);
        const redirectMod = redirectParsed.protocol === 'https:' ? https : http;
        redirectMod.get(redirectUrl, {
          headers: { Referer: 'https://pan.baidu.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        }, (redirectRes) => {
          res.set('Content-Type', redirectRes.headers['content-type'] || 'image/png');
          redirectRes.pipe(res);
        }).on('error', () => res.status(502).end());
        return;
      }
      res.set('Content-Type', imgRes.headers['content-type'] || 'image/png');
      imgRes.pipe(res);
    }).on('error', () => res.status(502).end());
  } catch (e) {
    res.status(500).end();
  }
});

// API: 轮询二维码状态
router.post('/api/qrcode/poll', requireAuth, async (req, res) => {
  const { sign } = req.body;
  if (!sign) {
    return res.json({ status: 'error', message: '缺少 sign 参数' });
  }

  // 取出之前保存的会话 Cookie 和 gid
  const session = scanSessions.get(sign);
  const sessionCookies = session ? session.sessionCookies : '';
  const gid = session ? session.gid : '';

  const result = await pollQRStatus(sign, sessionCookies, gid);

  // 如果确认成功或过期，清理会话
  if (result.status === 'confirmed' || result.status === 'expired') {
    scanSessions.delete(sign);
  }

  res.json(result);
});

// 定期清理过期会话（超过5分钟）
setInterval(() => {
  const now = Date.now();
  for (const [sign, session] of scanSessions) {
    if (now - session.createdAt > 5 * 60 * 1000) {
      scanSessions.delete(sign);
    }
  }
}, 60 * 1000);

module.exports = { router };
