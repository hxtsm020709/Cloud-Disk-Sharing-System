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

  // 路由
  app.use('/admin', admin.router);
  app.use('/admin', accounts.router);
  app.use('/admin', links.router);

  // 分享链接 — 扫码登录页
  app.get('/s/:token', (req, res) => {
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

    const account = db.get('SELECT * FROM accounts WHERE id = ? AND is_deleted = 0', [link.account_id]);

    let statusText = '正常';
    let statusClass = 'dot-green';
    if (link.status === 'expired') { statusText = '已过期'; statusClass = 'dot-yellow'; }
    else if (link.status === 'disabled') { statusText = '已停用'; statusClass = 'dot-red'; }
    else if (link.use_count >= (link.max_uses || 20)) { statusText = '已达上限'; statusClass = 'dot-red'; }

    const settings = db.getAllSettings();

    res.render('scan', {
      layout: false,
      token: link.token,
      accountId: link.account_id,
      accountName: account ? account.nickname : '未知',
      accountVipType: account ? (account.vip_type || '--') : '--',
      accountCookieStatus: account ? (account.cookie_status || 'unknown') : 'unknown',
      expireAt: link.first_used_at
        ? (link.expire_at ? link.expire_at.slice(0, 16) : '--')
        : ('首次使用后 ' + (link.expire_hours || 24) + ' 小时内有效'),
      useCount: link.use_count,
      maxUses: link.max_uses || 20,
      linkStatus: link.status,
      statusText: statusText,
      statusClass: statusClass,
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

      console.log(`[confirm] 登录失败${isVerifyBlock ? '(验证拦截)' : isQrExpired ? '(QR过期)' : isQrRelated ? '(QR问题)' : ''}，尝试切换备用账号...`);

      const allAccounts = db.all('SELECT * FROM accounts WHERE is_deleted = 0 AND is_paused = 0 AND id != ?', [link.account_id]);
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
        result.rotatedVipType = account.vip_type;
      } else if (!result.success) {
        if (isQrExpired || isQrRelated) {
          result.message = '二维码已过期，请刷新PC端百度网盘登录页面获取新二维码后重新扫码';
        } else if (isVerifyBlock) {
          result.message = '所有账号均触发安全验证，请在常用网络环境下重新获取 Cookie';
        } else {
          result.message = '所有可用账号均已失效，请联系管理员更新 Cookie';
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

    res.json(result);
  });

  // 根路径重定向
  app.get('/', (req, res) => {
    res.redirect('/admin/dashboard');
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
        console.log(`手机访问: https://${lanIP}:${httpsPort}/admin/login`);
        console.log(`员工扫码: https://${lanIP}:${httpsPort}/s/<token>`);
      }
    });
  }

  http.createServer(app).listen(config.port, config.host, () => {
    const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`服务已启动: http://${host}:${config.port}`);
    console.log(`管理后台: http://${host}:${config.port}/admin/login`);
  });
}

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
