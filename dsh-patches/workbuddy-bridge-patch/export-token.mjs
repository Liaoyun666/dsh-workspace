// 导出 WorkBuddy 桌面登录态（accessToken + refreshToken + 账号信息）到本地文件
// 不做刷新、不打印明文，只写文件；明文只在文件的 accessToken/refreshToken 字段里。
import fs from 'node:fs';
import path from 'node:path';
import { readDesktopCredential, AUTH_FILE } from './desktop-credential.mjs';

const cred = await readDesktopCredential();
const outDir = process.env.EXPORT_DIR ?? 'C:/Users/user/.dsh';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(outDir, `workbuddy-auth-export-${stamp}.json`);

const payload = {
  exportedAt: new Date().toISOString(),
  sourceFile: AUTH_FILE,
  account: {
    uid: cred.uid ?? null,
    domain: cred.domain ?? null,
    enterpriseId: cred.enterpriseId ?? null,
  },
  accessToken: cred.accessToken,
  refreshToken: cred.refreshToken,
  expiresAt: cred.expiresAtMs ? new Date(cred.expiresAtMs).toISOString() : null,
  expiresAtMs: cred.expiresAtMs ?? null,
  notes: [
    'CN 端点: chat https://copilot.tencent.com/v2/chat/completions , billing https://www.codebuddy.cn',
    '刷新: POST https://copilot.tencent.com/v2/plugin/auth/token/refresh , headers: X-Refresh-Token + X-Auth-Refresh-Source: workbuddy + X-User-Id + X-No-Enterprise-Id:1 + X-Domain',
    'chat 请求头另需: Authorization: Bearer <accessToken>, Content-Type: application/json, X-Product: SaaS, User-Agent: WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2, Origin/Referer: https://www.codebuddy.cn',
  ],
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(target, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });

const mask = (v) => (typeof v === 'string' && v.length > 14 ? `${v.slice(0, 10)}…${v.slice(-6)}` : String(v));
console.log('written:', target);
console.log('bytes:', fs.statSync(target).size);
console.log('uid:', payload.account.uid);
console.log('domain:', payload.account.domain);
console.log('expiresAt:', payload.expiresAt);
console.log('accessToken:', mask(payload.accessToken), `(${payload.accessToken?.length ?? 0} chars)`);
console.log('refreshToken:', mask(payload.refreshToken), `(${payload.refreshToken?.length ?? 0} chars)`);
