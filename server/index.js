const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const config = require('./config');
const database = require('./database');
const admin = require('./routes/admin');
const accounts = require('./routes/accounts');
const links = require('./routes/links');

async function start() {
  // 初始化数据库
  await database.init();
  admin.ensureAdmin();

  const app = express();

  // 视图引擎
  const expressLayouts = require('express-ejs-layouts');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('layout', 'layout');
  app.use(expressLayouts);

  // 中间件
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Session
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24小时
    },
  }));

  // 管理后台登录（根层级，隐藏入口）
  const { redirectIfAuth } = require('./middleware/auth');
  app.get(config.loginPath, redirectIfAuth, (req, res) => {
    res.render('login', {
      title: '管理员登录',
      error: null,
      layout: false,
      loginPath: config.loginPath,
    });
  });
  app.post(config.loginPath, redirectIfAuth, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.render('login', {
        title: '管理员登录',
        error: '请输入用户名和密码',
        layout: false,
        loginPath: config.loginPath,
      });
    }
    const bcrypt = require('bcrypt');
    const adminRow = database.get('SELECT * FROM admins WHERE username = ?', [username]);
    if (!adminRow || !bcrypt.compareSync(password, adminRow.password_hash)) {
      return res.render('login', {
        title: '管理员登录',
        error: '用户名或密码错误',
        layout: false,
        loginPath: config.loginPath,
      });
    }
    req.session.adminId = adminRow.id;
    req.session.adminUsername = adminRow.username;
    res.redirect('/admin/dashboard');
  });
  app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect(config.loginPath));
  });

  // 路由
  app.use('/admin', admin.router);
  app.use('/admin', accounts.router);
  app.use('/admin', links.router);

  // 分享链接 — 扫码登录页
  app.get('/s/:token', async (req, res) => {
    const db = require('./database');
    let link = db.get("SELECT * FROM share_links WHERE token = ?", [req.params.token]);
    if (!link) {
      return res.render('scan-expired', { layout: false });
    }

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmtNow = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    if (link.status === 'active' && !link.first_used_at) {
      const expireDate = new Date(now.getTime() + (link.expire_hours || 24) * 3600000);
      const expireAt = `${expireDate.getFullYear()}-${pad(expireDate.getMonth()+1)}-${pad(expireDate.getDate())} ${pad(expireDate.getHours())}:${pad(expireDate.getMinutes())}:${pad(expireDate.getSeconds())}`;
      db.run("UPDATE share_links SET first_used_at = ?, expire_at = ? WHERE id = ?", [fmtNow, expireAt, link.id]);
      link.first_used_at = fmtNow;
      link.expire_at = expireAt;
    }

    if (link.status === 'active' && link.expire_at) {
      const expireDate = new Date(link.expire_at.replace(' ', 'T'));
      if (expireDate <= now) {
        db.run("UPDATE share_links SET status = 'expired' WHERE id = ?", [link.id]);
        link.status = 'expired';
      }
    }

    let account = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [link.account_id]);

    // 共享链接打开时，若账号已停用/Cookie过期，立即按SVIP优先切换
    if (link.is_pool === 1 && link.status === 'active' && account && (account.is_paused === 1 || account.cookie_status === 'expired')) {
      const { checkCookieValid } = require('./services/baidu-auth');
      const { decrypt } = require('./utils/crypto');
      const vipRank = { 'svip': 0, 'vip': 1, 'normal': 2 };

      const candidates = db.all('SELECT * FROM accounts WHERE is_deleted = 0 AND is_paused = 0 AND id != ?', [account.id]);
      candidates.sort((a, b) => (vipRank[a.vip_type] ?? 3) - (vipRank[b.vip_type] ?? 3));

      for (const acc of candidates) {
        try {
          const testCookie = decrypt(acc.cookie_encrypted);
          const validCheck = await checkCookieValid(testCookie);
          if (validCheck.valid) {
            const vip = validCheck.vipType || acc.vip_type;
            db.run('UPDATE accounts SET cookie_status=\'valid\', vip_type=?, cookie_updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [vip, acc.id]);
            db.run('UPDATE share_links SET account_id = ? WHERE id = ?', [acc.id, link.id]);
            account = acc;
            link.account_id = acc.id;
            console.log(`[scan-page] 链接#${link.display_number || link.id} 自动切换至${vip?.toUpperCase() || '?'}账号: ${acc.nickname}`);
            break;
          }
        } catch(e) { /* skip */ }
      }
    }

    let statusText = '正常';
    let statusClass = 'dot-green';
    if (account && account.is_paused === 1) {
      statusText = '被管理员停用';
      statusClass = 'dot-red';
    } else if (account && account.cookie_status === 'expired') {
      statusText = 'Cookie已失效';
      statusClass = 'dot-red';
    } else if (link.status === 'expired') {
      statusText = '链接已过期';
      statusClass = 'dot-yellow';
    } else if (link.status === 'disabled') {
      statusText = '已停用';
      statusClass = 'dot-red';
    } else if (link.use_count >= (link.max_uses || 20)) {
      statusText = '已达上限';
      statusClass = 'dot-red';
    }

    const settings = db.getAllSettings();

    let remainingHours = null;
    if (link.first_used_at && link.expire_at && link.status === 'active') {
      const expireMs = new Date(link.expire_at.replace(' ', 'T')).getTime();
      const remainingMs = expireMs - Date.now();
      if (remainingMs > 0) remainingHours = (remainingMs / 3600000).toFixed(1);
    }

    res.render('scan', {
      layout: false,
      token: link.token,
      displayNumber: link.display_number,
      accountId: link.account_id,
      accountName: account ? account.nickname : '未知',
      expireAt: link.first_used_at
        ? (link.expire_at ? link.expire_at.slice(0, 16) : '--')
        : ('首次使用后 ' + (link.expire_hours || 24) + ' 小时内有效'),
      remainingHours,
      useCount: link.use_count,
      maxUses: link.max_uses || 20,
      linkStatus: link.status,
      statusText: statusText,
      statusClass: statusClass,
      accountPaused: account ? (account.is_paused === 1) : false,
      accountCookieExpired: account ? (account.cookie_status === 'expired') : false,
      settings: settings,
    });
  });

  // 分享链接 — 确认扫码 API（含自动切换 + 次数限制）
  app.post('/s/:token/confirm', async (req, res) => {
    const db = require('./database');
    const { decrypt } = require('./utils/crypto');
    const { confirmQRLogin, checkCookieValid } = require('./services/baidu-auth');

    const { qrContent } = req.body;
    if (!qrContent) return res.json({ success: false, message: '未检测到二维码' });

    console.log('[confirm] QR sign:', (qrContent.match(/sign=([^&]+)/) || [])[1]?.slice(0, 16) || '?');

    let link = db.get(
      "SELECT * FROM share_links WHERE token = ? AND status = 'active' AND (first_used_at IS NULL OR expire_at > datetime('now', 'localtime'))",
      [req.params.token]
    );
    if (!link) return res.json({ success: false, message: '链接已失效' });

    if (!link.first_used_at) {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const fmtNow = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const expireD = new Date(now.getTime() + (link.expire_hours || 24) * 3600000);
      const expireAt = `${expireD.getFullYear()}-${pad(expireD.getMonth()+1)}-${pad(expireD.getDate())} ${pad(expireD.getHours())}:${pad(expireD.getMinutes())}:${pad(expireD.getSeconds())}`;
      db.run("UPDATE share_links SET first_used_at = ?, expire_at = ? WHERE id = ?", [fmtNow, expireAt, link.id]);
      link.first_used_at = fmtNow;
      link.expire_at = expireAt;
    }

    const maxUses = link.max_uses || 20;
    if (link.use_count >= maxUses) {
      db.run("UPDATE share_links SET status='disabled' WHERE id=?", [link.id]);
      return res.json({ success: false, message: `该链接已达到使用上限（${maxUses}次），已自动停用` });
    }

    let account = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0 AND is_paused = 0', [link.account_id]);
    if (!account) {
      return res.json({ success: false, message: '账号不可用，请联系管理员' });
    }

    let cookieText;
    try { cookieText = decrypt(account.cookie_encrypted); }
    catch (e) { return res.json({ success: false, message: 'Cookie 解密失败' }); }

    let result = await confirmQRLogin(qrContent, cookieText);

    if (!result.success) {
      console.log('[confirm] FAILED for account:', account.nickname);
      console.log('[confirm]', (result.requests || '').split('\n').join('\n[confirm] '));
    }

    if (!result.success && link.is_pool === 1) {
      const isVerifyBlock = result.errno === 400023;
      const isQrExpired = result.qrExpired === true;
      const isQrRelated = /二维码|qr.*(过期|失效|超时|expired|invalid|timeout)/i.test(result.message || '');
      const shouldMarkExpired = !isVerifyBlock && !isQrExpired && !isQrRelated;

      if (shouldMarkExpired) {
        db.run(`UPDATE accounts SET cookie_status='expired', cookie_updated_at=datetime('now','localtime') WHERE id=?`, [account.id]);
      }

      console.log(`[confirm] 登录失败${isVerifyBlock ? '(验证拦截)' : isQrExpired ? '(QR过期)' : isQrRelated ? '(QR问题)' : ''}，尝试切换SVIP备用账号...`);

      const allAccounts = db.all('SELECT * FROM accounts WHERE is_deleted = 0 AND is_paused = 0 AND id != ?', [link.account_id]);
      // SVIP > VIP > 普通 优先排序
      const vipRank = { 'svip': 0, 'vip': 1, 'normal': 2 };
      allAccounts.sort((a, b) => (vipRank[a.vip_type] ?? 3) - (vipRank[b.vip_type] ?? 3));

      let rotated = false;

      for (const acc of allAccounts) {
        try {
          const testCookie = decrypt(acc.cookie_encrypted);
          const validCheck = await checkCookieValid(testCookie);
          if (validCheck.valid) {
            db.run(`UPDATE accounts SET cookie_status='valid', vip_type=?, cookie_updated_at=datetime('now','localtime') WHERE id=?`, [validCheck.vipType || acc.vip_type, acc.id]);
            db.run('UPDATE share_links SET account_id = ? WHERE id = ?', [acc.id, link.id]);

            console.log('[confirm] 切换到账号:', acc.nickname);
            result = await confirmQRLogin(qrContent, testCookie);
            account = acc;
            cookieText = testCookie;
            rotated = true;
            break;
          } else {
            db.run(`UPDATE accounts SET cookie_status='expired', cookie_updated_at=datetime('now','localtime') WHERE id=?`, [acc.id]);
          }
        } catch(e) { /* skip */ }
      }

      if (rotated) {
        result.rotated = true;
        result.rotatedTo = account.nickname;
      } else if (!result.success) {
        result.fallbackExhausted = true;
        if (isQrExpired || isQrRelated) {
          result.message = '二维码已过期，请刷新PC端百度网盘登录页面获取新二维码后重新扫码';
        } else if (isVerifyBlock) {
          result.message = '系统维护中，请稍后再试。如多次出现请于产品购买处联系客服处理。';
        } else {
          result.message = '服务暂时不可用，请于产品购买处联系客服处理。';
        }
      }
    }

    if (result.success) {
      db.run('UPDATE share_links SET use_count = use_count + 1 WHERE id = ?', [link.id]);
      link = db.get('SELECT * FROM share_links WHERE id = ?', [link.id]);
    }

    result.maxUses = maxUses;
    result.currentCount = link.use_count;
    result.remainingUses = Math.max(0, maxUses - link.use_count);

    db.run(
      'INSERT INTO usage_logs (share_link_id, account_id, action, ip_address, user_agent, details) VALUES (?, ?, ?, ?, ?, ?)',
      [link.id, account.id, result.success ? 'login_success' : 'login_fail', req.ip, req.get('user-agent') || '', result.message]
    );

    // 将技术错误转为用户友好提示（备用切换已处理过的错误不再覆盖）
    if (!result.success && result.message && !result.fallbackExhausted) {
      const raw = result.message;
      if (result.errno === 400023) {
        result.message = '账号需要安全验证，请联系管理员更新Cookie';
      } else if (raw.includes('Cookie已失效') || raw.includes('Cookie 已失效')) {
        result.message = '账号登录已失效，请联系管理员';
      } else if (raw.includes('二维码已过期')) {
        result.message = '二维码已过期，请刷新PC端百度网盘重新扫码';
      } else if (raw.includes('errno=')) {
        result.message = '登录失败，请于产品购买处联系客服处理。';
      }
    }

    res.json(result);
  });

  // 首页（用户侧默认页面）
  app.get('/', (req, res) => {
    res.render('home', { layout: false });
  });

  // 获取本机局域网 IP
  function getLanIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  }

  // HTTPS 证书存在则启动 HTTPS（本地部署），否则仅 HTTP（云端部署时平台在边缘层提供 HTTPS）
  const certDir = path.join(__dirname, '..', 'data', 'certs');
  const keyPath = path.join(certDir, 'localhost-key.pem');
  const certPath = path.join(certDir, 'localhost-cert.pem');
  const hasCerts = fs.existsSync(keyPath) && fs.existsSync(certPath);
  const lanIP = getLanIP();

  if (hasCerts) {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    const httpsPort = config.port + 443;
    https.createServer(httpsOptions, app).listen(httpsPort, config.host, () => {
      console.log(`HTTPS 服务器: https://localhost:${httpsPort}`);
      if (lanIP !== '127.0.0.1') {
        console.log(`管理后台: https://${lanIP}:${httpsPort}` + config.loginPath);
        console.log(`员工扫码: https://${lanIP}:${httpsPort}/s/<token>`);
      }
    });
  }

  http.createServer(app).listen(config.port, config.host, () => {
    const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`服务已启动: http://${host}:${config.port}`);
    console.log(`管理后台: http://${host}:${config.port}` + config.loginPath);
  });
}

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
