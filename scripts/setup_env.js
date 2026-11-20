'use strict';
// Never overwrite an existing local configuration or print its secrets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const file = path.join(__dirname, '..', '.env');
let text = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
for (const name of ['JWT_SECRET', 'ADMIN_SECRET']) {
  text = text.replace(new RegExp(`^${name}=$`, 'm'), `${name}=${crypto.randomBytes(32).toString('hex')}`);
}
try {
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  console.log('已创建 .env 并生成随机密钥；请按需填写 GitHub OAuth 配置。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env 已存在，保留原配置不覆盖。');
}
