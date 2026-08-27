'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR_NAME = 'dsh-web-adapter';

function resolveStateDir(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  if (env.DSWEB_STATE_DIR) return String(env.DSWEB_STATE_DIR);
  if (platform === 'win32') {
    const root = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(root, STATE_DIR_NAME);
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', STATE_DIR_NAME);
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), STATE_DIR_NAME);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort on restricted filesystems */ }
  }
  return dir;
}

function writePrivateFile(file, value) {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on restricted filesystems */ }
  }
}

function readOrCreateSecret(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const created = crypto.randomBytes(32).toString('base64url');
  try {
    writePrivateFile(file, created + '\n');
    return created;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
    throw new Error('gateway secret file exists but is empty: ' + file);
  }
}

function writeJsonAtomic(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp');
  const body = JSON.stringify(value, null, 2) + '\n';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on restricted filesystems */ }
    }
  } catch (error) {
    if (fd !== undefined && fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* ignore secondary failure */ }
    }
    try { fs.unlinkSync(temp); } catch (_) { /* ignore secondary failure */ }
    throw error;
  }
}

function migrateLegacyState({ legacyDir, destinationDir }) {
  if (!legacyDir || !destinationDir || path.resolve(legacyDir) === path.resolve(destinationDir)) {
    return { copied: [], skipped: [] };
  }
  ensurePrivateDir(destinationDir);
  if (!fs.existsSync(legacyDir)) return { copied: [], skipped: [] };
  const destinationEntries = fs.readdirSync(destinationDir);
  if (destinationEntries.length) {
    const skipped = ['profiles', 'accounts.json', 'calibration.json']
      .filter((name) => fs.existsSync(path.join(legacyDir, name)));
    return { copied: [], skipped };
  }

  const copied = [];
  for (const name of ['profiles', 'accounts.json', 'calibration.json']) {
    const source = path.join(legacyDir, name);
    const target = path.join(destinationDir, name);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
    copied.push(name);
  }
  return { copied, skipped: [] };
}

module.exports = {
  STATE_DIR_NAME,
  resolveStateDir,
  ensurePrivateDir,
  readOrCreateSecret,
  writeJsonAtomic,
  migrateLegacyState,
};
