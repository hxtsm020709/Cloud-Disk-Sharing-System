const axios = require('axios');
const https = require('https');

// 模拟真实浏览器的请求实例
const client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'max-age=0',
  },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxRedirects: 0,
  validateStatus: status => status < 500,
});

// 从 Set-Cookie 头部提取 cookie 键值对
function extractCookiesFromHeaders(headers) {
  const setCookie = headers['set-cookie'] || [];
  const parts = [];
  for (const sc of setCookie) {
    const kv = sc.split(';')[0].trim();
    if (kv && kv.includes('=')) parts.push(kv);
  }
  return parts.join('; ');
}

// 合并多个 cookie 字符串，去重（后者覆盖前者）
function mergeCookies(...cookieStrings) {
  const map = {};
  for (const str of cookieStrings) {
    if (!str) continue;
    str.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const key = pair.substring(0, idx).trim();
        const val = pair.substring(idx + 1).trim();
        if (val) map[key] = val;
      }
    });
  }
  return Object.entries(map).map(([k, v]) => k + '=' + v).join('; ');
}

/**
 * 检查 Cookie 是否有效
 * 访问百度网盘首页，看是否被重定向到登录页
 */
async function checkCookieValid(cookieText) {
  const result = {
    valid: false,
    username: null,
    vipType: null,
    expireDate: null,
    raw: null,
  };

  try {
    // 访问百度网盘首页，允许跟随重定向
    const res = await axios.get('https://pan.baidu.com/disk/home', {
      headers: {
        Cookie: cookieText,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 15000,
      maxRedirects: 5,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    // 检查最终 URL
    const finalUrl = res.request?.res?.responseUrl || res.request?.path || '';

    if (finalUrl.includes('passport.baidu.com') || finalUrl.includes('login')) {
      result.raw = 'Cookie 已失效（跳转到登录页）';
      return result;
    }

    const html = res.data;
    if (typeof html !== 'string') {
      result.raw = '异常响应';
      return result;
    }

    // 从页面中提取用户名
    const nameMatch = html.match(/"username"\s*:\s*"([^"]+)"/);
    if (nameMatch) result.username = nameMatch[1];

    // 检测会员类型 — 用JSON标记精确匹配，避免误判页面文本
    if (html.match(/"(?:is_)?svip"\s*:\s*1/) || html.match(/"is_vipv2"\s*:\s*1/) || html.match(/"is_vip_v2"\s*:\s*1/)) {
      result.vipType = 'svip';
    } else if (html.match(/"(?:is_)?vip"\s*:\s*1/)) {
      result.vipType = 'vip';
    }

    // 提取会员到期时间
    const expireMatch = html.match(/"vip_end_time"\s*:\s*(\d+)/) || html.match(/"last_vipv2_end_time"\s*:\s*(\d+)/) || html.match(/"last_svip_end_time"\s*:\s*(\d+)/);
    if (expireMatch) {
      const ts = parseInt(expireMatch[1]);
      if (ts > 0) {
        result.expireDate = new Date(ts * (ts < 9e9 ? 1000 : 1)).toISOString().slice(0, 10);
      }
    }

    result.valid = true;
    result.raw = 'Cookie 有效';
    if (result.username) result.raw += '，用户: ' + result.username;
    if (result.vipType) result.raw += '，' + result.vipType.toUpperCase();
  } catch (err) {
    // 检查错误响应中的重定向
    if (err.response?.headers?.location) {
      const loc = err.response.headers.location;
      if (loc.includes('passport.baidu.com') || loc.includes('login')) {
        result.raw = 'Cookie 已失效（跳转到登录页）';
        return result;
      }
    }
    result.raw = '检测失败: ' + err.message;
  }

  return result;
}

/**
 * 从百度网盘 API 获取会员信息
 * 依据：pan.baidu.com/rest/2.0/membership/user 返回的 user_tag 中 is_vip/is_svip/is_vipv2 标记
 */
async function fetchVipInfo(cookieText) {
  const result = {
    vipType: null,
    expireDate: null,
    nickname: null,
  };

  try {
    const res = await client.get('https://pan.baidu.com/rest/2.0/membership/user', {
      params: { method: 'query', app_id: '250528' },
      headers: { Cookie: cookieText, Referer: 'https://pan.baidu.com/' },
    });

    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    if (!data || data.error_code !== 0) return result;

    // 解析 user_tag（百度将用户会员标记放在这个JSON字符串里）
    let tag = {};
    if (data.user_tag && typeof data.user_tag === 'string') {
      try { tag = JSON.parse(data.user_tag); } catch {}
    }

    // 判断当前会员类型：SVIP > VIP V2 > VIP
    if (tag.is_svip === 1) {
      result.vipType = 'svip';
    } else if (tag.is_vipv2 === 1 || tag.is_vip_v2 === 1) {
      result.vipType = 'svip';   // vipv2 对标 svip
    } else if (tag.is_vip === 1) {
      result.vipType = 'vip';
    }

    // 提取到期时间：从 previous_product_cluster 找最新有效期
    const clusters = data.previous_product_cluster || {};
    const now = Math.floor(Date.now() / 1000);
    let latestExpire = 0;
    let latestExpired = 0;
    const candidateClusters = ['vipv2', 'svip', 'vip'];
    for (const key of candidateClusters) {
      const c = clusters[key];
      if (c && c.expired_time) {
        if (c.expired_time > now) {
          if (c.expired_time > latestExpire) {
            latestExpire = c.expired_time;
            result.vipType = (key === 'vipv2' || key === 'svip') ? 'svip' : result.vipType || 'vip';
          }
        } else if (c.expired_time > latestExpired) {
          latestExpired = c.expired_time;
        }
      }
    }
    if (latestExpire > 0) {
      result.expireDate = new Date(latestExpire * 1000).toISOString().slice(0, 10);
    } else if (latestExpired > 0 && !result.vipType) {
      // 所有 VIP 均已过期，记录最近的过期时间作为参考
      result.expireDate = new Date(latestExpired * 1000).toISOString().slice(0, 10);
    }

    // 用户名：从 level_info 或 product_infos 中提取
    const levelInfo = data.level_info || {};
    if (levelInfo.v10_id) {
      result.nickname = levelInfo.v10_id;
    }
  } catch (err) {
    // 静默失败
  }

  // 页面解析作为补充（获取用户名等）
  try {
    const res = await axios.get('https://pan.baidu.com/', {
      headers: {
        Cookie: cookieText,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000,
      maxRedirects: 5,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    const html = typeof res.data === 'string' ? res.data : '';
    const nameMatch = html.match(/"username":"([^"]+)"/);
    if (nameMatch) result.nickname = nameMatch[1];
    if (!result.vipType) {
      if (html.match(/"(?:is_)?svip"\s*:\s*1/) || html.match(/"is_vipv2"\s*:\s*1/)) result.vipType = 'svip';
      else if (html.match(/"(?:is_)?vip"\s*:\s*1/)) result.vipType = 'vip';
    }
  } catch (e) { /* 静默 */ }

  return result;
}

/**
 * 解析二维码内容，提取 sign 等参数
 * 二维码内容通常是: https://passport.baidu.com/v2/api/qrcode/scancode?sign=xxx&...
 */
function parseQRSign(qrContent) {
  const params = {};
  try {
    const url = new URL(qrContent);
    params.sign = url.searchParams.get('sign');
    params.tpl = url.searchParams.get('tpl');
    params.apiver = url.searchParams.get('apiver');
    params.bd_page_type = url.searchParams.get('bd_page_type');
    // 也尝试其他可能的参数
    for (const [key, value] of url.searchParams) {
      if (!params[key]) {
        params[key] = value;
      }
    }
  } catch {
    // 如果不是完整URL，尝试正则提取 sign
    const signMatch = qrContent.match(/sign=([^&]+)/);
    if (signMatch) params.sign = signMatch[1];
  }
  return params;
}

/**
 * 确认扫码登录
 * 模拟手机浏览器打开扫码链接 + 使用 VIP Cookie 确认登录
 *
 * 关键：Step1 GET 返回的 Set-Cookie（会话 Cookie）必须在 Step2 POST 中回传，
 * 否则百度会因缺少会话凭证而触发 400023（需要验证后登录）。
 */
async function confirmQRLogin(qrContent, cookieText) {
  const mobileUA = 'Mozilla/5.0 (Linux; Android 13; SM-S9080) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const baiduAppUA = 'Mozilla/5.0 (Linux; Android 13; SM-S9080) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 baiduboxapp/15.2.5';
  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const requestsLog = [];

  // 诊断：检查 Cookie 里是否有关键 token
  const cookieKeys = cookieText.split(';').map(p => p.trim().split('=')[0].toUpperCase());
  const hasBDUSS = cookieKeys.includes('BDUSS');
  const hasSTOKEN = cookieKeys.includes('STOKEN');
  if (!hasBDUSS) {
    requestsLog.push('DIAG: Cookie 不包含 BDUSS — 这是最关键的登录凭证，缺少会导致 400023');
  }
  if (!hasSTOKEN) {
    requestsLog.push('DIAG: Cookie 不包含 STOKEN — 缺少可能导致验证失败');
  }
  requestsLog.push('DIAG: Cookie keys: ' + cookieKeys.join(', '));

  // Cookie 预热：先用桌面 UA 访问百度网盘首页，让百度信任此 IP 上的 Cookie
  try {
    console.log('[confirmQRLogin] warming cookie...');
    const warmRes = await axios.get('https://pan.baidu.com/', {
      headers: { Cookie: cookieText, 'User-Agent': desktopUA },
      timeout: 6000,
      maxRedirects: 3,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    const warmUrl = warmRes.request?.res?.responseUrl || '';
    requestsLog.push('Warm → ' + warmUrl.slice(0, 80));
  } catch (e) {
    requestsLog.push('Warm err: ' + (e.message?.slice(0, 60) || ''));
  }

  // 从 QR 内容中提取 sign 及其他参数
  let sign = '';
  let qrParams = {};
  let confirmPageUrl;

  const trimmed = qrContent.trim();
  try {
    const urlObj = new URL(trimmed);
    sign = urlObj.searchParams.get('sign') || '';
    // 提取所有 QR 参数原样回传（PC/手机端参数不同，不能硬编码）
    const paramKeys = ['sign', 'tpl', 'apiver', 'cmd', 'bd_page_type', 'qrloginfrom', 'lp', 'client',
      'isBaiduApp', 'adapter', 'callback', 'loginProxy', 'loginfor', 'type', 'qrsign'];
    for (const key of paramKeys) {
      const v = urlObj.searchParams.get(key);
      if (v) qrParams[key] = v;
    }
    if (urlObj.hostname === 'wappass.baidu.com' && urlObj.pathname === '/wp/') {
      confirmPageUrl = trimmed;
    }
  } catch {
    const signMatch = qrContent.match(/sign=([^&]+)/);
    if (signMatch) sign = signMatch[1];
  }

  if (!sign) {
    return { success: false, message: '无法从二维码中提取 sign', requests: requestsLog.join('\n') };
  }

  console.log('[confirmQRLogin] sign:', sign.slice(0, 16), 'params:', JSON.stringify(qrParams));

  // 根据 QR 来源选择 UA（百度App的二维码需要带百度App标识）
  const isFromBaiduApp = qrParams.isBaiduApp === '1' || /baiduboxapp/i.test(trimmed);
  const stepUA = isFromBaiduApp ? baiduAppUA : mobileUA;
  requestsLog.push('UA: ' + (isFromBaiduApp ? 'baiduApp' : 'mobile') + ', QR params: ' + JSON.stringify(qrParams).slice(0, 150));

  // 构建确认页面 URL
  if (!confirmPageUrl) {
    const tpl = qrParams.tpl || 'netdisk';
    const apiver = qrParams.apiver || 'v3';
    const cmd = qrParams.cmd || 'login';
    const lp = qrParams.lp || 'pc';
    const client = qrParams.client || '';
    const bd_page_type = qrParams.bd_page_type || '';
    confirmPageUrl = 'https://wappass.baidu.com/wp/?qrlogin&sign=' + sign + '&tpl=' + tpl + '&apiver=' + apiver + '&cmd=' + cmd + '&lp=' + lp + '&client=' + client + '&bd_page_type=' + bd_page_type;
  }

  // ====== Step 1: GET 确认页面，捕获会话 Cookie ======
  let pageToken = '';
  let pageHtml = '';
  let sessionCookies = '';

  try {
    const res = await axios.get(confirmPageUrl, {
      headers: { Cookie: cookieText, 'User-Agent': stepUA },
      timeout: 15000,
      maxRedirects: 0,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: s => s < 500,
    });

    pageHtml = typeof res.data === 'string' ? res.data : '';

    // 捕获响应中的 Set-Cookie（会话 Cookie，Step2 必须回传否则 400023）
    const setCookieHeaders = res.headers['set-cookie'] || [];
    const sessionParts = [];
    for (const sc of setCookieHeaders) {
      const kv = sc.split(';')[0].trim();
      if (kv && kv.includes('=')) sessionParts.push(kv);
    }
    sessionCookies = sessionParts.join('; ');
    requestsLog.push('Step1 → HTTP' + res.status + ', HTML ' + pageHtml.length + 'B, session cookies: ' + sessionParts.length);

    // 处理 3xx 重定向
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location || '';
      if (loc.includes('pan.baidu.com')) {
        return { success: true, message: '登录成功', requests: requestsLog.join('\n') };
      }
      if (loc.includes('passport.baidu.com') && loc.includes('login')) {
        return { success: false, message: 'Cookie已失效', requests: requestsLog.join('\n') };
      }
      // 跟随重定向
      try {
        const r2 = await axios.get(loc.startsWith('http') ? loc : 'https://wappass.baidu.com' + loc, {
          headers: { Cookie: cookieText, 'User-Agent': stepUA },
          timeout: 10000,
          maxRedirects: 3,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        });
        pageHtml = typeof r2.data === 'string' ? r2.data : pageHtml;
        const sc2 = r2.headers['set-cookie'] || [];
        for (const sc of sc2) {
          const kv = sc.split(';')[0].trim();
          if (kv && kv.includes('=')) sessionParts.push(kv);
        }
        sessionCookies = sessionParts.join('; ');
        requestsLog.push('Step1-redirect → HTTP' + r2.status + ', HTML ' + pageHtml.length + 'B');
      } catch (re) {
        requestsLog.push('Step1-redirect err: ' + (re.message?.slice(0, 60) || ''));
      }
    }

    // 提取页面 token（兼容PC端和手机端不同页面格式）
    let tokenMatch = pageHtml.match(/token:\s*'([^']+)'/) ||
                     pageHtml.match(/token:\s*"([^"]+)"/) ||
                     pageHtml.match(/token:\s*([a-zA-Z0-9]{15,})/) ||
                     pageHtml.match(/token[=:]\s*([a-zA-Z0-9]{10,})/) ||
                     pageHtml.match(/data-token=["']([^"']+)["']/);
    if (tokenMatch) {
      pageToken = tokenMatch[1];
      requestsLog.push('Step1 token: ' + pageToken.slice(0, 20) + '...');
    } else {
      // 手机端页面可能用不同变量名
      const altMatch = pageHtml.match(/['"]([a-zA-Z0-9]{20,40})['"],\s*authsid/) ||
                       pageHtml.match(/vcodeSign['"]\s*:\s*['"]([^'"]+)['"]/) ||
                       pageHtml.match(/passToken\s*=\s*['"]([^'"]+)['"]/);
      if (altMatch) {
        pageToken = altMatch[1];
        requestsLog.push('Step1 token(alt): ' + pageToken.slice(0, 20) + '...');
      } else {
        requestsLog.push('Step1 token not found, html preview: ' + pageHtml.slice(0, 400));
        if (/已过期|已失效|已超时|expired|timeout/i.test(pageHtml)) {
          return { success: false, qrExpired: true, message: '二维码已过期，请刷新PC端百度网盘获取新二维码', requests: requestsLog.join('\n') };
        }
        // 没找到token也不立即返回失败，让Step2尝试无token确认
        requestsLog.push('Step1 未提取到token，尝试无token直接确认');
      }
    }

  } catch (e) {
    requestsLog.push('Step1 error: ' + (e.message?.slice(0, 100) || ''));
    return { success: false, message: '访问确认页面失败', requests: requestsLog.join('\n') };
  }

  // Step 1 未提取到 token — 手机端页面是 JS 动态渲染，返回页面HTML供调试
  if (!pageToken) {
    requestsLog.push('=== 页面HTML首部 ===');
    requestsLog.push(pageHtml.slice(0, 500));
    requestsLog.push('=== 页面HTML尾部 ===');
    requestsLog.push(pageHtml.slice(-500));
    return { success: false, qrExpired: true, message: '手机端扫码尚不支持，请使用PC端百度网盘二维码登录', requests: requestsLog.join('\n') };
  }

  // ====== Step 2: POST 确认登录（VIP Cookie + 会话 Cookie 合并回传） ======
  const confirmData = {
    authsid: '',
    authFromRisk: '',
    tpl: qrParams.tpl || 'netdisk',
    lp: qrParams.lp || 'pc',
    cmd: qrParams.cmd || 'login',
    token: pageToken,
    sign: sign,
    client: qrParams.client || '',
    offline: '0',
    adapter: qrParams.adapter || '',
    clientfrom: '',
    skin: '',
    liveAbility: '',
    suppcheck: '',
    isBaiduApp: qrParams.isBaiduApp || '0',
    qrloginfrom: qrParams.qrloginfrom || '',
    callback: qrParams.callback || '',
    loginProxy: qrParams.loginProxy || '',
    redirectU: '',
    jumpurl: '',
    zid: '',
    isAuthed: '0',
    bd_page_type: qrParams.bd_page_type || '',
    loginfor: qrParams.loginfor || '',
  };

  // 合并 Cookie：VIP Cookie + Step1 返回的会话 Cookie
  const combinedCookie = sessionCookies ? cookieText + '; ' + sessionCookies : cookieText;

  try {
    const params = new URLSearchParams(confirmData);
    const postUrl = 'https://wappass.baidu.com/wp/?qrlogin&v=' + Date.now();
    const res = await axios.post(postUrl, params.toString(), {
      headers: {
        Cookie: combinedCookie,
        'User-Agent': stepUA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: confirmPageUrl,
      },
      timeout: 15000,
      maxRedirects: 5,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const rawBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const data = typeof res.data === 'string' ? (() => { try { return JSON.parse(res.data); } catch { return res.data; } })() : res.data;
    requestsLog.push('Step2 POST → HTTP' + res.status + ', response: ' + rawBody.slice(0, 300));

    // 字符串响应直接匹配成功标记
    if (typeof data === 'string') {
      if (/errno=0|"errno":0|"no":0|loginok|登录成功/i.test(data)) {
        return { success: true, message: '登录成功', requests: requestsLog.join('\n') };
      }
      return { success: false, message: '确认响应异常，请重试', requests: requestsLog.join('\n') };
    }

    const errno = parseInt(data?.errInfo?.no ?? data?.errno ?? data?.code);
    if (errno === 0) {
      return { success: true, message: '登录确认成功', requests: requestsLog.join('\n') };
    }
    if (!isNaN(errno)) {
      let msg = data?.errInfo?.msg || data?.errmsg || '';
      if (errno === 400023) {
        let diagHint = '';
        if (!hasBDUSS) diagHint = ' [Cookie缺少BDUSS，需重新提取]';
        else if (!hasSTOKEN) diagHint = ' [Cookie缺少STOKEN，建议重新提取]';
        else diagHint = ' [Cookie完整但仍需验证，该账号可能开启了登录保护]';
        msg = '该账号需要短信/安全验证后才能登录' + diagHint;
      }
      const isQrErr = /已过期|已失效|已超时|expired|timeout|二维码.*(过期|失效)/i.test(msg);
      return { success: false, errno, qrExpired: isQrErr || undefined, message: '确认失败: errno=' + errno + (msg ? ' (' + msg + ')' : ''), requests: requestsLog.join('\n') };
    }

    const finalUrl2 = res.request?.res?.responseUrl || '';
    if (finalUrl2.includes('pan.baidu.com') || finalUrl2.includes('loginok')) {
      return { success: true, message: '登录成功', requests: requestsLog.join('\n') };
    }

    // 未匹配到明确成功标记，记录原始响应并返回失败
    requestsLog.push('Step2 unexpected response, raw: ' + JSON.stringify(data).slice(0, 300));
    return { success: false, message: '确认响应异常，请重试', requests: requestsLog.join('\n') };
  } catch (e) {
    const loc = e.response?.headers?.location || '';
    const status = e.response?.status || '?';
    requestsLog.push('Step2 error: HTTP' + status + ', Loc: ' + loc.slice(0, 100));

    if (loc.includes('pan.baidu.com')) {
      return { success: true, message: '登录成功', requests: requestsLog.join('\n') };
    }

    return { success: false, message: '确认请求失败: ' + (e.message?.slice(0, 80) || ''), requests: requestsLog.join('\n') };
  }
}

/**
 * 获取 gid（百度 QR 登录流程必需的全局唯一 ID）
 */
async function getGid() {
  const tt = Date.now();
  try {
    const res = await client.get('https://passport.baidu.com/v2/api/getgid', {
      params: {
        tpl: 'netdisk',
        apiver: 'v3',
        tt: tt,
        gid: '',
        callback: '',
      },
      headers: {
        Referer: 'https://pan.baidu.com/',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
    });

    const rawData = res.data;
    let data = null;
    if (typeof rawData === 'string') {
      try { data = JSON.parse(rawData); } catch {}
    } else if (typeof rawData === 'object') {
      data = rawData;
    }

    if (data && data.gid) {
      console.log('[getGid] gid:', data.gid);
      return { gid: data.gid };
    }
    // 有些返回把 gid 包在 data 里
    if (data && data.data && data.data.gid) {
      console.log('[getGid] gid (nested):', data.data.gid);
      return { gid: data.data.gid };
    }
    console.log('[getGid] failed, response:', JSON.stringify(data).slice(0, 200));
    return { gid: null };
  } catch (err) {
    console.log('[getGid] error:', err.message);
    return { gid: null };
  }
}

/**
 * 向百度请求登录二维码
 * 模拟 PC 客户端请求二维码
 */
async function requestQRCode() {
  const debugLog = [];
  try {
    // 先获取 gid
    const { gid } = await getGid();
    const gidStr = gid || '';
    debugLog.push('gid=' + (gidStr || 'null'));

    const tt = Date.now();
    const res = await client.get('https://passport.baidu.com/v2/api/getqrcode', {
      params: {
        lp: 'pc',
        tpl: 'netdisk',
        apiver: 'v3',
        tt: tt,
        qrloginfrom: 'pc',
        gid: gidStr,
        callback: '',
      },
      headers: {
        Referer: 'https://pan.baidu.com/',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
    });

    // 捕获百度下发的会话 Cookie（轮询时必须回传）
    const sessionCookies = extractCookiesFromHeaders(res.headers);
    debugLog.push('HTTP' + res.status + ', cookies: ' + (sessionCookies ? sessionCookies.slice(0, 120) : '(none)'));

    // 解析响应 — 可能是 JSON，也可能是 JSONP
    let data = null;
    const rawData = res.data;
    if (typeof rawData === 'string') {
      try { data = JSON.parse(rawData); } catch {
        // 可能是 JSONP 格式: callback({...})
        const jsonpMatch = rawData.match(/^[\w.]*\((\{.*\})\)\s*;?\s*$/s);
        if (jsonpMatch) {
          try { data = JSON.parse(jsonpMatch[1]); } catch {}
        }
      }
    } else if (typeof rawData === 'object') {
      data = rawData;
    }

    debugLog.push('data keys: ' + (data ? Object.keys(data).join(', ') : 'null'));
    console.log('[requestQRCode]', debugLog.join(' | '));
    console.log('[requestQRCode] response:', JSON.stringify(data).slice(0, 500));

    // 百度有时把数据包在 errno=0 的 data 字段里
    if (data) {
      if (!data.sign && data.data && typeof data.data === 'object') {
        data = data.data;
        debugLog.push('unwrapped nested data');
      }
      // 也尝试从 result 提取
      if (!data.sign && data.result && typeof data.result === 'object') {
        data = data.result;
        debugLog.push('unwrapped nested result');
      }
    }

    if (data && data.sign) {
      const imgurl = data.imgurl || '';
      // qrcode 字段可能是 URL，也可能是 base64 字符串
      const qrcodeRaw = data.qrcode || '';

      let qrcodeBase64 = '';

      // 如果 qrcode 已经是 base64 data URI，直接使用
      if (qrcodeRaw && qrcodeRaw.startsWith('data:image')) {
        qrcodeBase64 = qrcodeRaw;
      }
      // 如果 qrcode 是纯 base64 字符串（没有前缀）
      else if (qrcodeRaw && qrcodeRaw.length > 200 && /^[A-Za-z0-9+/=]+$/.test(qrcodeRaw.slice(0, 100))) {
        qrcodeBase64 = 'data:image/png;base64,' + qrcodeRaw;
      }

      // 否则从图片 URL 下载
      const imageUrl = imgurl || (qrcodeRaw && !qrcodeBase64 ? qrcodeRaw : '');
      if (!qrcodeBase64 && imageUrl) {
        try {
          qrcodeBase64 = await fetchQRImage(imageUrl);
        } catch (e) {
          debugLog.push('img download failed: ' + e.message);
        }
      }

      return {
        success: true,
        sign: data.sign,
        imgurl: imgurl,
        qrcodeBase64: qrcodeBase64,
        scanUrl: 'https://wappass.baidu.com/wp/?qrlogin&sign=' + data.sign + '&tpl=netdisk&apiver=v3',
        gid: gidStr,
        sessionCookies: sessionCookies, // 传给轮询阶段
        _debug: debugLog.join(' | '),
      };
    }

    return { success: false, message: '获取二维码失败: ' + (data?.errmsg || data?.msg || '未知错误'), _debug: debugLog.join(' | ') };
  } catch (err) {
    debugLog.push('error: ' + err.message);
    console.log('[requestQRCode]', debugLog.join(' | '));
    return { success: false, message: '请求二维码出错: ' + err.message, _debug: debugLog.join(' | ') };
  }
}

/**
 * 轮询二维码状态
 * 尝试多个已知的百度轮询地址
 */
async function pollQRStatus(sign, sessionCookies, gid) {
  const tt = Date.now();
  const baseParams = {
    sign: sign,
    lp: 'pc',
    tpl: 'netdisk',
    apiver: 'v3',
    tt: tt,
    qrloginfrom: 'pc',
    gid: gid || '',
    callback: 'bp' + tt,
  };

  // 构建完整 URL（callback 为空时可能返回纯 JSON）
  const paramsNoCb = { ...baseParams, callback: '' };
  const paramsWithCb = { ...baseParams };

  const pollUrls = [
    'https://passport.baidu.com/v2/api/loginqr?' + new URLSearchParams(paramsNoCb).toString(),
    'https://passport.baidu.com/v2/api/loginqr?' + new URLSearchParams(paramsWithCb).toString(),
  ];

  const debugInfo = { urls_tried: 0, status_codes: [], errors: [], content_types: [] };

  for (const url of pollUrls) {
    debugInfo.urls_tried++;
    try {
      const reqHeaders = {
        Referer: 'https://pan.baidu.com/',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      };
      // 回传百度下发的会话 Cookie
      if (sessionCookies) {
        reqHeaders.Cookie = sessionCookies;
      }

      const res = await client.get(url, { headers: reqHeaders });
      debugInfo.status_codes.push(res.status);

      // 更新会话 Cookie
      const newCookies = extractCookiesFromHeaders(res.headers);
      if (newCookies) {
        sessionCookies = mergeCookies(sessionCookies, newCookies);
      }

      const contentType = res.headers['content-type'] || '';
      debugInfo.content_types.push(contentType);

      const rawData = res.data;

      // 跳过图片 / HTML 响应
      if (contentType.includes('image') || (typeof rawData === 'string' && (rawData.startsWith('\x89PNG') || rawData.startsWith('<!DOCTYPE') || rawData.startsWith('<html')))) {
        debugInfo.errors.push('Skipped non-JSON (type=' + contentType + ', starts=' + String(rawData).slice(0, 40) + ')');
        continue;
      }

      // 解析响应 — JSON 或 JSONP
      let data = null;
      if (typeof rawData === 'string') {
        try { data = JSON.parse(rawData); } catch {
          const m = rawData.match(/^[\w.]*\((\{.*\})\)\s*;?\s*$/s);
          if (m) { try { data = JSON.parse(m[1]); } catch {} }
          else { debugInfo.errors.push('Parse fail: ' + rawData.slice(0, 120)); continue; }
        }
      } else if (typeof rawData === 'object') {
        data = rawData;
      }

      if (!data) { debugInfo.errors.push('data is null'); continue; }

      const errno = data.errno !== undefined ? parseInt(data.errno) : NaN;
      console.log('[pollQRStatus] url=' + url.split('?')[0] + ' errno=' + errno + ' keys=' + (Object.keys(data).join(',')));

      // === 状态判断 ===
      // errno === 0: 可能已确认（有 session 数据时）或等待中
      if (errno === 0) {
        // 尝试直接从响应提取 Cookie
        let cookieStr = buildCookieFromData(data);
        if (!cookieStr) cookieStr = buildCookieFromData(data.session || {});

        if (cookieStr) {
          console.log('[pollQRStatus] CONFIRMED — cookie extracted directly, len=' + cookieStr.length);
          return { status: 'confirmed', cookieStr, _debug: debugInfo };
        }

        // 用户确认后，用会话 Cookie 访问百度首页获取真实 Cookie
        if (sessionCookies) {
          console.log('[pollQRStatus] errno=0, trying login completion via pan.baidu.com...');
          const finalCookie = await completeLogin(sessionCookies);
          if (finalCookie) {
            console.log('[pollQRStatus] CONFIRMED — cookie from login completion, len=' + finalCookie.length);
            return { status: 'confirmed', cookieStr: finalCookie, _debug: debugInfo };
          }
          debugInfo.errors.push('login completion failed');
        }

        // 有 channel_id 则通过 unicast 交换
        if (data.channel_id) {
          console.log('[pollQRStatus] errno=0 with channel_id, trying unicast...');
          const authResult = await getAuthByChannel(data.channel_id, sign);
          if (authResult) return { ...authResult, _debug: debugInfo };
          debugInfo.errors.push('unicast failed');
        }

        // errno=0 但没有 session 数据也没有 channel_id → 可能仍在等待
        return { status: 'waiting', _debug: { ...debugInfo, baidu_response: data } };
      }

      // errno === 1: 等待扫码
      if (errno === 1) {
        return { status: 'waiting', _debug: { ...debugInfo, baidu_response: data } };
      }

      // errno === 2: 已扫码，等待确认
      if (errno === 2) {
        return { status: 'scanned', _debug: { ...debugInfo, baidu_response: data } };
      }

      // 其他 errno: 错误或过期
      if (errno < 0 || errno > 2) {
        debugInfo.errors.push('errno=' + errno + (data.errmsg ? ' ' + data.errmsg : ''));
        return { status: 'expired', _debug: { ...debugInfo, baidu_response: data } };
      }

      return { status: 'waiting', _debug: { ...debugInfo, baidu_response: data } };

    } catch (e) {
      debugInfo.errors.push('Request failed: ' + (e.message?.slice(0, 80) || ''));
      continue;
    }
  }

  return { status: 'waiting', _debug: debugInfo };
}

/**
 * 通过 channel_id 获取认证 token
 * 尝试多个已知端点
 */
async function getAuthByChannel(channelId, sign) {
  const endpoints = [
    {
      url: 'https://passport.baidu.com/channel/unicast',
      params: { channel_id: channelId, tpl: 'netdisk', apiver: 'v3', callback: '' },
    },
    {
      url: 'https://passport.baidu.com/v2/api/loginqr',
      params: { channel_id: channelId, tpl: 'netdisk', apiver: 'v3', callback: '', sign: sign },
    },
  ];

  for (const ep of endpoints) {
    try {
      const res = await client.get(ep.url, {
        params: ep.params,
        headers: {
          Referer: 'https://passport.baidu.com/',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
        },
      });

      const data = typeof res.data === 'string' ? (() => { try { return JSON.parse(res.data); } catch { return null; } })() : res.data;
      console.log('[getAuthByChannel] endpoint:', ep.url.split('/').pop(), 'response:', JSON.stringify(data).slice(0, 500));

      if (data) {
        // 尝试多个路径提取 cookie
        const sources = [data, data.session, data.data, data.result, data.auth, data.info];
        for (const src of sources) {
          if (!src || typeof src !== 'object') continue;
          const cookieStr = buildCookieFromData(src);
          if (cookieStr) {
            console.log('[getAuthByChannel] Cookie extracted from', ep.url.split('/').pop());
            return { status: 'confirmed', cookieStr };
          }
        }
      }
    } catch (err) {
      console.log('[getAuthByChannel] error for', ep.url.split('/').pop() + ':', err.message);
    }
  }
  return null;
}

/**
 * 从响应数据构建 Cookie 字符串
 */
/**
 * 用户确认扫码后，用会话 Cookie 走完登录重定向链，
 * 从 Set-Cookie 响应头中提取真实的 BDUSS/STOKEN 等
 */
async function completeLogin(sessionCookies) {
  let allCookies = sessionCookies;
  let currentUrl = 'https://pan.baidu.com/disk/home';
  const visited = new Set();

  for (let i = 0; i < 8; i++) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    try {
      const res = await axios.get(currentUrl, {
        headers: {
          Cookie: allCookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        timeout: 15000,
        maxRedirects: 0, // 手动跟踪重定向以捕获中间 Set-Cookie
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        validateStatus: s => s < 500,
      });

      // 捕获 Set-Cookie
      const newCookies = extractCookiesFromHeaders(res.headers);
      if (newCookies) {
        allCookies = mergeCookies(allCookies, newCookies);
        console.log('[completeLogin] step', i, 'HTTP' + res.status, 'new cookies:', newCookies.slice(0, 150));
      }

      // 3xx 重定向
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        const loc = res.headers.location;
        currentUrl = loc.startsWith('http') ? loc : ('https://' + (loc.startsWith('//') ? loc.slice(2) : 'pan.baidu.com' + (loc.startsWith('/') ? '' : '/') + loc));
        continue;
      }

      // 200 OK — 登录成功，已到达目标页
      if (res.status === 200) {
        // 从页面尝试提取用户名确认登录成功
        const html = typeof res.data === 'string' ? res.data : '';
        if (html.includes('username') || html.includes('init') || html.includes('disk')) {
          console.log('[completeLogin] success — arrived at pan.baidu.com');
          break;
        }
      }

      break;
    } catch (e) {
      console.log('[completeLogin] step', i, 'error:', e.message);
      // 即使出错也检查是否有 Set-Cookie
      if (e.response?.headers) {
        const errCookies = extractCookiesFromHeaders(e.response.headers);
        if (errCookies) {
          allCookies = mergeCookies(allCookies, errCookies);
        }
        // 检查重定向
        const loc = e.response.headers.location;
        if (loc) {
          currentUrl = loc.startsWith('http') ? loc : ('https://pan.baidu.com' + (loc.startsWith('/') ? '' : '/') + loc);
          continue;
        }
      }
      break;
    }
  }

  // 从累积的 Cookie 中提取有效的账号 Cookie
  const cookieStr = buildCookieFromData(
    Object.fromEntries(
      allCookies.split(';').map(p => {
        const idx = p.indexOf('=');
        return idx > 0 ? [p.substring(0, idx).trim(), p.substring(idx + 1).trim()] : null;
      }).filter(Boolean)
    )
  );

  return cookieStr || (allCookies !== sessionCookies ? allCookies : null);
}

function buildCookieFromData(data) {
  if (!data || typeof data !== 'object') return null;
  const cookies = [];

  // 目标 cookie 名称（全大写）
  const targetCookies = [
    'BDUSS', 'STOKEN', 'PTOKEN', 'BAIDUID',
    'BDSTOKEN', 'PAN_TOKEN', 'UBDUSS',
  ];

  // 构建小写 → 目标名称的映射
  for (const name of targetCookies) {
    const value = data[name] || data[name.toLowerCase()];
    if (value && typeof value === 'string' && value.length > 3) {
      cookies.push(name + '=' + value);
    }
  }

  // 额外字段
  const extras = ['token', 'session_key', 'sessionkey', 'access_token', 'sign'];
  for (const key of extras) {
    const value = data[key];
    if (value && typeof value === 'string' && value.length > 3) {
      cookies.push(key + '=' + value);
    }
  }

  // 递归检查嵌套对象
  if (cookies.length === 0) {
    for (const key of ['session', 'data', 'result', 'auth', 'info']) {
      if (data[key] && typeof data[key] === 'object') {
        const nested = buildCookieFromData(data[key]);
        if (nested) return nested;
      }
    }
  }

  return cookies.length > 0 ? cookies.join('; ') : null;
}

/**
 * 下载二维码图片并转为 base64
 */
async function fetchQRImage(imgurl) {
  let fullUrl;
  if (imgurl.startsWith('http')) {
    fullUrl = imgurl;
  } else if (imgurl.startsWith('//')) {
    fullUrl = 'https:' + imgurl;
  } else {
    fullUrl = 'https://' + imgurl;
  }
  const res = await client.get(fullUrl, {
    responseType: 'arraybuffer',
    headers: {
      Referer: 'https://pan.baidu.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  // res.data 是 Buffer (Node.js axios + arraybuffer)
  const base64 = Buffer.from(res.data).toString('base64');
  const contentType = res.headers['content-type'] || 'image/png';
  console.log('[fetchQRImage] downloaded, type:', contentType, 'size:', res.data.length);
  return 'data:' + contentType + ';base64,' + base64;
}

module.exports = {
  checkCookieValid,
  fetchVipInfo,
  parseQRSign,
  confirmQRLogin,
  requestQRCode,
  pollQRStatus,
  fetchQRImage,
};
