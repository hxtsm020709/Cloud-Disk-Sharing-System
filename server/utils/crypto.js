const crypto = require('crypto');
const config = require('../config');

function deriveKey() {
  return crypto.createHash('sha256').update(config.encryptionKey).digest();
}

function encrypt(plainText) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(encryptedText) {
  const key = deriveKey();
  const parts = encryptedText.split(':');
  if (parts.length !== 3) throw new Error('密文格式无效');
  const [ivHex, authTagHex, cipherHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function maskPhone(phone) {
  if (!phone || phone.length < 7) return phone || '--';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

function maskCookie(cookieText) {
  if (!cookieText || cookieText.length < 13) return '****';
  return cookieText.slice(0, 8) + '****' + cookieText.slice(-4);
}

module.exports = { encrypt, decrypt, maskPhone, maskCookie };
