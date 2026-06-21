# 网盘共享系统 — 技术设计文档

> 版本：v1.0  
> 更新日期：2026-06-04

---

## 1. 技术栈选型

| 层级 | 技术 | 选型理由 |
|------|------|----------|
| 后端框架 | Node.js + Express | 生态丰富、适合 API 服务、与前端统一语言 |
| 前端 | 原生 HTML + CSS + JavaScript | 页面数量少、无需 SPA 框架、降低复杂度 |
| 数据库 | SQLite（通过 better-sqlite3） | 零配置、本地部署、适合单机场景 |
| 二维码解析 | jsQR（前端库） | 纯前端解析二维码，无需上传图片 |
| HTTP 请求 | axios / got | 向百度 API 发起请求 |
| 加密 | Node.js crypto 模块 | Cookie 等敏感数据加密存储 |
| 任务调度 | node-cron | 定时检测 Cookie 有效性和会员到期 |
| 登录认证 | express-session + bcrypt | 管理员后台密码保护 |

## 2. 项目目录结构

```
网盘共享系统/
├── docs/                       # 项目文档
│   ├── requirements.md         # 需求规格
│   ├── technical-design.md     # 本文档
│   ├── design-spec.md          # UI 设计规范
│   └── development-plan.md     # 开发计划
├── dev-logs/                   # 开发日志（按日）
├── server/                     # 后端代码
│   ├── index.js                # 入口文件
│   ├── config.js               # 配置文件
│   ├── database.js             # 数据库初始化与操作
│   ├── routes/
│   │   ├── admin.js            # 管理端路由
│   │   ├── share.js            # 分享链接路由
│   │   └── api.js              # API 接口
│   ├── services/
│   │   ├── baidu-auth.js       # 百度登录认证核心逻辑
│   │   ├── cookie-checker.js   # Cookie 有效性检测
│   │   └── link-manager.js     # 分享链接管理
│   ├── middleware/
│   │   └── auth.js             # 管理员认证中间件
│   └── utils/
│       ├── crypto.js           # 加密工具
│       └── logger.js           # 日志工具
├── public/                     # 前端静态文件
│   ├── admin/                  # 管理端页面
│   │   ├── login.html          # 管理员登录页
│   │   ├── dashboard.html      # 后台首页/仪表盘
│   │   ├── accounts.html       # 账号列表
│   │   ├── account-detail.html # 单个账号详情
│   │   ├── add-account.html    # 添加账号（扫码+手动）
│   │   └── links.html          # 分享链接管理
│   ├── scan/                   # 员工扫码页
│   │   └── index.html          # 扫码登录页面
│   ├── css/
│   │   └── style.css           # 全局样式
│   └── js/
│       └── common.js           # 公共 JS 逻辑
├── data/                       # 运行时数据（自动创建）
│   └── database.sqlite         # SQLite 数据库文件
├── .env                        # 环境变量（密钥等）
├── .env.example                # 环境变量模板
├── package.json
├── CLAUDE.md                   # Claude 工作指引
└── README.md
```

## 3. 数据库设计

### 3.1 表结构

```sql
-- 账号表
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,           -- 账号昵称
    phone TEXT,                       -- 绑定手机号（脱敏）
    vip_type TEXT,                    -- 会员类型: svip / vip
    vip_expire_date TEXT,             -- 会员到期日期 (YYYY-MM-DD)
    cookie_encrypted TEXT NOT NULL,   -- 加密后的 Cookie
    cookie_status TEXT DEFAULT 'unknown',  -- unknown / valid / expired
    cookie_updated_at TEXT,           -- Cookie 最后更新时间
    notes TEXT,                       -- 备注
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    is_deleted INTEGER DEFAULT 0
);

-- 分享链接表
CREATE TABLE share_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,       -- 随机分享 Token
    account_id INTEGER NOT NULL,      -- 关联的账号 ID
    expire_hours INTEGER NOT NULL,    -- 有效期（小时）
    expire_at TEXT NOT NULL,          -- 过期时间
    use_count INTEGER DEFAULT 0,     -- 使用次数
    status TEXT DEFAULT 'active',     -- active / disabled / expired
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- 使用日志表
CREATE TABLE usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_link_id INTEGER,
    account_id INTEGER,
    action TEXT,                      -- scan / login_success / login_fail
    ip_address TEXT,
    user_agent TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 管理员表
CREATE TABLE admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
```

## 4. 核心业务流程

### 4.1 扫码提取 Cookie 流程（管理员添加账号）

```
管理员 → 后台"添加账号" → 选择"扫码提取"
     → 页面生成一个模拟的百度网盘登录二维码
     → 管理员用手机百度网盘 App 扫码并确认登录
     → 页面拦截扫码确认请求，提取 Cookie 和账号信息
     → 加密保存到数据库
```

> **注意**：此流程需要深入分析百度网盘 App 的登录协议。作为备选，管理员也可以使用浏览器开发者工具手动复制 Cookie 后粘贴导入。

### 4.2 员工扫码登录流程（分享链接使用）

```
员工PC启动百度网盘 → 显示登录二维码
                  → 百度服务器返回 QR 数据（含 sign/key 等参数）

员工手机打开分享链接 → 页面调用摄像头 → 扫描 PC 端二维码
                  → jsQR 解析二维码内容（得到百度 passport URL）
                  → 将解析结果发回我们的服务器

服务器接收 QR 数据 → 取出存储的 VIP Cookie
                  → 向百度服务器发送"确认登录"请求（携带 Cookie + QR 参数）
                  → 处理百度的响应（成功/失败）
                  → 返回结果给手机端

手机端显示结果  → 成功：提示员工查看 PC 端
              → 失败：显示错误信息 + 重试按钮
```

### 4.3 百度登录二维码协议分析（待验证）

百度网盘 PC 端登录二维码通常包含类似以下格式的 URL：
```
https://passport.baidu.com/v2/api/qrcode?sign=xxx&bd_page_type=xxx&...
```

扫码后，手机 App 会调用类似以下 API 确认登录：
```
https://passport.baidu.com/v2/api/qrcode/confirm?sign=xxx&...
```

> **待办**：需要抓包分析百度网盘 PC 端 + 手机端的完整扫码登录流程，确认 API 接口、参数、以及是否需要额外的签名算法。

## 5. 安全设计

### 5.1 数据加密
- Cookie 使用 AES-256-GCM 加密存储
- 加密密钥存放在 `.env` 文件中，不提交到版本控制
- 初始化时自动生成随机密钥

### 5.2 访问控制
- 管理后台所有接口需要 Session 认证
- 管理员密码使用 bcrypt 哈希存储
- 连续登录失败限制

### 5.3 分享链接安全
- Token 使用 crypto.randomBytes(32) 生成
- Token 不包含任何账号信息
- 员工端只拿到 Token，无法获取原始 Cookie

## 6. 部署方案

### 6.1 本机部署（初期）
- Node.js 环境
- 使用 http（localhost 访问）
- 摄像头调用需要 HTTPS → 手机和 PC 在同一 WiFi 下可使用 localhost

### 6.2 摄像头权限处理
- 现代浏览器要求在 HTTPS 或 localhost 下才能调用摄像头
- 手机通过局域网访问 PC 时，需要解决 HTTPS 问题
- 方案：使用自签名证书 + mkcert 工具生成本地信任证书

## 7. 技术难点与应对策略

| 难点 | 风险等级 | 应对策略 |
|------|----------|----------|
| 百度登录 API 逆向 | 高 | 抓包分析 + 参考开源项目 + 迭代调试 |
| 反爬/风控 | 高 | 模拟真实 User-Agent、请求头、时序 |
| Cookie 频繁失效 | 中 | 自动检测 + 提醒管理员更新 |
| 手机扫码页 HTTPS | 中 | mkcert 本地证书 / ngrok 内网穿透 |
