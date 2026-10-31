// Read the WorkBuddy desktop credential, including the 5.6+ at-rest envelopes.
//
// The token fields are AES-256-GCM envelopes sealed by the app; the key lives in
// the WorkBuddy-modified Electron's private `workbuddyStorage` binding, reachable
// only by running that binary as plain Node. Everything here mirrors the bridge's
// own reader so a measurement cannot disagree with the plugin about who is signed
// in. Nothing prints, logs, or returns the tokens beyond the caller's closure.
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_FILE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info',
);
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

/**
 * The Electron runtime as the Windows installer ships it. The 5.6.2 installer can
 * put it at the drive root, so probe the usual places instead of guessing one.
 */
function helperCandidates() {
  const list = [];
  const override = process.env.WORKBUDDY_ELECTRON_BIN;
  if (typeof override === 'string' && override.trim() !== '') list.push(override.trim());
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) list.push(path.join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'));
    list.push('E:\\workbuddy\\WorkBuddy.exe', 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe');
    for (const drive of ['C', 'D', 'E', 'F']) list.push(`${drive}:\\WorkBuddy\\WorkBuddy.exe`);
  } else if (process.platform === 'darwin') {
    list.push('/Applications/WorkBuddy.app/Contents/MacOS/Electron');
  }
  return list.filter((candidate, index) => fs.existsSync(candidate) && list.indexOf(candidate) === index);
}

function atRestSecretKey() {
  const errors = [];
  for (const binary of helperCandidates()) {
    try {
      const output = execFileSync(binary, ['-e', HELPER_SCRIPT], {
        timeout: 60000, maxBuffer: 1048576, windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
      }).trim();
      const payload = JSON.parse(output);
      const secret = payload.atRestSecretKey;
      if (typeof secret === 'string' && Buffer.from(secret, 'base64').length === 32) return secret;
      errors.push(`${binary}: unusable payload`);
    } catch (error) {
      errors.push(`${binary}: ${error.message}`);
    }
  }
  throw new Error(`no WorkBuddy key helper worked (${errors.join('; ')})`);
}

const AAD_PREFIX = Buffer.from('WB-AAD\0', 'ascii');

function lengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

/** Transcribed from the app's buildAuthenticatedContextAad (field framing, suite 1). */
function authenticatedContextAad(keyId, suite) {
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    AAD_PREFIX,
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

function openField(protectorKey, envelope) {
  const decipher = createDecipheriv('aes-256-gcm', protectorKey, envelope.nonce, { authTagLength: 16 });
  decipher.setAAD(authenticatedContextAad(envelope.keyId, envelope.suite));
  decipher.setAuthTag(envelope.authTag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
}

function parseEnvelope(value) {
  if (typeof value !== 'object' || value === null || value['$wbEncrypted'] !== 1 || typeof value.envelope !== 'string') return undefined;
  const inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  const decode = (raw, length) => {
    const bytes = Buffer.from(raw, 'base64');
    return length === undefined || bytes.length === length ? bytes : undefined;
  };
  const nonce = decode(inner.nonce, 12);
  const authTag = decode(inner.authTag, 16);
  const ciphertext = decode(inner.ciphertext);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
  if (inner.suite !== 1 || !/^[0-9a-f]{16}$/u.test(inner.keyId)) return undefined;
  return { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext };
}

/**
 * Read the desktop credential and open any at-rest fields.
 * @returns {{accessToken: string, refreshToken: string, expiresAtMs: number, domain: string, uid: string, enterpriseId: string|undefined}}
 */
export function readDesktopCredential() {
  if (!fs.existsSync(AUTH_FILE)) throw new Error(`no auth file at ${AUTH_FILE}`);
  const document = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document;
  const account = typeof document.account === 'object' && document.account !== null ? document.account : {};

  const fields = {};
  let protectorKey;
  for (const field of ['accessToken', 'refreshToken']) {
    const value = auth[field];
    if (typeof value === 'string') { fields[field] = value; continue; }
    const envelope = parseEnvelope(value);
    if (envelope === undefined) throw new Error(`${field} is neither plaintext nor a decodable envelope`);
    protectorKey ??= createHash('sha256').update(atRestSecretKey(), 'utf8').digest();
    fields[field] = openField(protectorKey, envelope);
  }
  return {
    accessToken: fields.accessToken ?? '',
    refreshToken: fields.refreshToken ?? '',
    expiresAtMs: typeof auth.expiresAt === 'number' ? auth.expiresAt : 0,
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    uid: typeof account.uid === 'string' ? account.uid : '',
    enterpriseId: typeof account.enterpriseId === 'string' && account.enterpriseId !== '' ? account.enterpriseId : undefined,
  };
}

export { AUTH_FILE };
