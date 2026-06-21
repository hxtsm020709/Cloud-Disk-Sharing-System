require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  sessionSecret: process.env.SESSION_SECRET || 'fallback_secret_do_not_use_in_prod',
  encryptionKey: process.env.ENCRYPTION_KEY || 'fallback_key_32bytes_long!!',
  adminUser: process.env.ADMIN_USERNAME || 'admin',
  adminPass: process.env.ADMIN_PASSWORD || 'admin123',
  loginPath: process.env.LOGIN_PATH || '/yunpanadmin',
  dbPath: process.env.DB_PATH || './data/database.sqlite',
};
