'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { utils } = require('ssh2');
const { BaseAgent, createAgent } = require('ssh2/lib/agent.js');

// Same default names OpenSSH uses when ~/.ssh/config sets no IdentityFile.
const DEFAULT_IDENTITY_NAMES = Object.freeze([
  'id_rsa',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519',
  'id_ed25519_sk',
]);

const NO_KEY_MESSAGE = 'No SSH key found for this host. ssh checks the agent, IdentityFile in ~/.ssh/config, and the default keys in ~/.ssh.';

class SelectedKeysAgent extends BaseAgent {
  constructor(inner, keys) {
    super();
    this.inner = inner;
    this.keys = keys;
  }

  getIdentities(cb) {
    cb(null, this.keys.slice());
  }

  sign(pubKey, data, options, cb) {
    if (!this.inner || typeof this.inner.sign !== 'function') {
      const done = typeof options === 'function' ? options : cb;
      done(new Error('SSH agent could not sign with this key'));
      return;
    }
    this.inner.sign(pubKey, data, options, cb);
  }
}

function resolveAgentSocket(env = process.env, platform = process.platform) {
  if (platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  if (env && env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  if (platform !== 'darwin') return undefined;
  try {
    const value = execFileSync('launchctl', ['getenv', 'SSH_AUTH_SOCK'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function friendlyAuthError(message) {
  if (!message) return 'The server did not accept an SSH key from this computer.';
  if (/All configured authentication methods failed/i.test(message)) {
    return 'The server did not accept an SSH key from this computer.';
  }
  if (/Timed out while waiting for handshake/i.test(message)) {
    return 'Connection timed out after 15 seconds';
  }
  return message;
}

function isProbeAcceptedError(err) {
  const message = err && err.message;
  return typeof message === 'string' && message.indexOf('No private key available') !== -1;
}

function displayKeyPath(filePath, home = os.homedir()) {
  const full = path.resolve(filePath);
  const base = path.resolve(home || '');
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  const fold = process.platform === 'win32'
    ? (value) => value.toLowerCase()
    : (value) => value;
  if (!fold(full).startsWith(fold(prefix))) return full;
  const rest = full.slice(prefix.length).split(path.sep).join('/');
  return `~/${rest}`;
}

function isEncryptedPrivateKey(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  if (/Proc-Type:\s*4,ENCRYPTED/i.test(text)) return true;
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) return true;
  if (/^PuTTY-User-Key-File-/m.test(text)) {
    const enc = text.match(/^Encryption:\s*(.+)$/m);
    return !!enc && enc[1].trim().toLowerCase() !== 'none';
  }
  if (!/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)) return false;
  const cipher = openSshCipherName(text);
  return !!cipher && cipher !== 'none';
}

function openSshCipherName(text) {
  const decoded = decodeOpenSshPrivate(text);
  if (!decoded) return null;
  const cipher = readSshString(decoded, 15);
  return cipher ? cipher.value.toString('utf8') : null;
}

function extractOpenSshPublicBlob(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  const decoded = decodeOpenSshPrivate(text);
  if (!decoded) return null;
  let pos = 15;
  const cipher = readSshString(decoded, pos);
  if (!cipher) return null;
  pos = cipher.next;
  const kdf = readSshString(decoded, pos);
  if (!kdf) return null;
  pos = kdf.next;
  const kdfOptions = readSshString(decoded, pos);
  if (!kdfOptions) return null;
  pos = kdfOptions.next;
  if (pos + 4 > decoded.length) return null;
  const count = decoded.readUInt32BE(pos);
  pos += 4;
  if (count < 1) return null;
  const pub = readSshString(decoded, pos);
  return pub ? Buffer.from(pub.value) : null;
}

function decodeOpenSshPrivate(text) {
  const match = String(text).match(/-----BEGIN OPENSSH PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END OPENSSH PRIVATE KEY-----/);
  if (!match) return null;
  const decoded = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (decoded.length < 15 || decoded.toString('utf8', 0, 15) !== 'openssh-key-v1\0') return null;
  return decoded;
}

function readSshString(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + len;
  if (len < 0 || end > buf.length) return null;
  return { value: buf.subarray(start, end), next: end };
}

function parseIdentity(data) {
  try {
    return utils.parseKey(data);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function publicBlob(key) {
  if (!key || typeof key.getPublicSSH !== 'function') return null;
  try {
    const blob = key.getPublicSSH();
    return Buffer.isBuffer(blob) ? Buffer.from(blob) : null;
  } catch {
    return null;
  }
}

function isParsedPublic(key) {
  return !!key && !(key instanceof Error) && typeof key.getPublicSSH === 'function';
}

function isSecurityKey(key) {
  return !!(key && typeof key.type === 'string' && key.type.startsWith('sk-'));
}

function probeFromPublic(publicKey) {
  publicKey.isPrivateKey = function isPrivateKey() { return true; };
  return publicKey;
}

function blobsEqual(left, right) {
  return !!(left && right && left.equals(right));
}

function logicalLines(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = [];
  let pending = '';
  for (const line of raw) {
    const joined = pending ? pending + line : line;
    if (joined.endsWith('\\') && !joined.endsWith('\\\\')) {
      pending = joined.slice(0, -1);
      continue;
    }
    pending = '';
    lines.push(joined);
  }
  if (pending) lines.push(pending);
  return lines;
}

function splitConfigTokens(line) {
  const tokens = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '#') break;
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function newSection(kind, args) {
  return { kind, args, identityFiles: [], identitiesOnly: undefined };
}

function parseConfigSections(text) {
  const sections = [newSection('global', [])];
  let current = sections[0];
  for (const line of logicalLines(text)) {
    const tokens = splitConfigTokens(line);
    if (!tokens.length) continue;
    const keyword = tokens[0].toLowerCase();
    if (keyword === 'host') {
      current = newSection('host', tokens.slice(1));
      sections.push(current);
      continue;
    }
    if (keyword === 'match') {
      current = newSection('match', tokens.slice(1));
      sections.push(current);
      continue;
    }
    if (keyword === 'include') {
      sections.push({ kind: 'include', patterns: tokens.slice(1) });
      continue;
    }
    if (keyword === 'identityfile') {
      current.identityFiles.push(...tokens.slice(1));
      continue;
    }
    if (keyword === 'identitiesonly') {
      const value = String(tokens[1] || '').toLowerCase();
      if (value === 'yes' || value === 'no') current.identitiesOnly = value === 'yes';
    }
  }
  return sections;
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      if (i < pattern.length) re += escapeRegExp(pattern[i]);
      continue;
    }
    if (ch === '*') {
      re += '.*';
      continue;
    }
    if (ch === '?') {
      re += '.';
      continue;
    }
    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, end);
      i = end;
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      body = body.replace(/\\/g, '\\\\');
      re += negated ? `[^${body}]` : `[${body}]`;
      continue;
    }
    re += escapeRegExp(ch);
  }
  return re;
}

function globMatch(pattern, value) {
  try {
    return new RegExp(`^${globToRegExp(pattern)}$`).test(String(value));
  } catch {
    return false;
  }
}

function hostLineMatches(patterns, host) {
  let positive = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globMatch(pattern.slice(1), host)) return false;
    } else if (globMatch(pattern, host)) {
      positive = true;
    }
  }
  return positive;
}

function matchCriteria(args, ctx) {
  if (args.length === 1 && args[0].toLowerCase() === 'all') return true;
  let saw = false;
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i].toLowerCase();
    if (key === 'all') {
      saw = true;
      continue;
    }
    if (key !== 'host' && key !== 'user' && key !== 'localuser') return false;
    const pattern = args[i + 1];
    i += 1;
    if (!pattern) return false;
    const value = key === 'host' ? ctx.host : key === 'user' ? ctx.username : ctx.localUser;
    const matched = pattern.startsWith('!')
      ? !globMatch(pattern.slice(1), value)
      : globMatch(pattern, value);
    if (!matched) return false;
    saw = true;
  }
  return saw;
}

function sectionApplies(section, ctx) {
  if (section.kind === 'global') return true;
  if (section.kind === 'host') return hostLineMatches(section.args, ctx.host);
  if (section.kind === 'match') return matchCriteria(section.args, ctx);
  return false;
}

function expandIdentityPath(value, ctx) {
  const replaced = String(value).replace(/%[%hprdu]/g, (token) => {
    if (token === '%%') return '%';
    if (token === '%h') return ctx.host || '';
    if (token === '%p') return String(ctx.port || 22);
    if (token === '%r') return ctx.username || '';
    if (token === '%d' || token === '%u') {
      return token === '%d' ? (ctx.home || '') : (ctx.localUser || '');
    }
    return token;
  });
  if (replaced === '~') return ctx.home;
  if (replaced.startsWith('~/') || replaced.startsWith('~\\')) {
    return path.resolve(path.join(ctx.home, replaced.slice(2)));
  }
  return path.resolve(replaced);
}

function uniquePaths(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function resolveIdentitySelection(sections, ctx) {
  const identityFiles = [];
  let identitiesOnly = false;
  let sawIdentity = false;
  let sawOnly = false;
  for (const section of sections) {
    if (!section || section.kind === 'include' || !sectionApplies(section, ctx)) continue;
    if (!sawOnly && section.identitiesOnly !== undefined) {
      identitiesOnly = section.identitiesOnly;
      sawOnly = true;
    }
    for (const value of section.identityFiles || []) {
      sawIdentity = true;
      if (String(value).toLowerCase() === 'none') continue;
      identityFiles.push(expandIdentityPath(value, ctx));
    }
  }
  return {
    identityFiles: uniquePaths(identityFiles),
    identitiesOnly,
    explicit: sawIdentity,
  };
}

function defaultIdentityPaths(sshDir) {
  return DEFAULT_IDENTITY_NAMES.map((name) => path.join(sshDir, name));
}

function resolveIncludePattern(pattern, sshDir, home) {
  let target = pattern;
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    target = expandIdentityPath(target, { home, host: '', username: '', port: 22, localUser: '' });
  } else if (!path.isAbsolute(target)) {
    target = path.resolve(sshDir, target);
  } else {
    target = path.resolve(target);
  }
  if (!/[*?\[]/.test(target)) return fs.existsSync(target) ? [target] : [];
  const dir = path.dirname(target);
  const base = path.basename(target);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => globMatch(base, name)).sort().map((name) => path.join(dir, name));
}

function loadConfigSections(filePath, sshDir, home, depth = 0, seen = new Set()) {
  const real = path.resolve(filePath);
  if (depth > 8 || seen.has(real) || !fs.existsSync(real) || !fs.statSync(real).isFile()) return [];
  seen.add(real);
  let text = '';
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch {
    return [];
  }
  const expanded = [];
  for (const section of parseConfigSections(text)) {
    if (section.kind !== 'include') {
      expanded.push(section);
      continue;
    }
    for (const pattern of section.patterns || []) {
      for (const included of resolveIncludePattern(pattern, sshDir, home)) {
        expanded.push(...loadConfigSections(included, sshDir, home, depth + 1, seen));
      }
    }
  }
  return expanded;
}

function loadSiblingPublic(filePath) {
  try {
    return parseIdentity(fs.readFileSync(`${filePath}.pub`));
  } catch {
    return null;
  }
}

function inspectKeyFile(filePath, home, platform) {
  let info;
  try {
    info = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  let pem;
  try {
    pem = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (!pem.length) return null;
  const loose = platform !== 'win32' && (info.mode & 0o077) !== 0;
  const text = pem.toString('utf8');
  const encrypted = isEncryptedPrivateKey(text);
  let publicKey = loadSiblingPublic(filePath);
  if (!isParsedPublic(publicKey)) {
    const blob = extractOpenSshPublicBlob(text);
    publicKey = blob ? parseIdentity(blob) : null;
  }
  if (!isParsedPublic(publicKey) && !encrypted) publicKey = parseIdentity(pem);
  if (!isParsedPublic(publicKey)) publicKey = null;

  let privateKey = null;
  if (!encrypted && !loose) {
    const parsed = parseIdentity(pem);
    if (isParsedPublic(parsed) && typeof parsed.isPrivateKey === 'function' && parsed.isPrivateKey()) {
      privateKey = parsed;
      if (!publicKey) publicKey = parsed;
    }
  }

  const securityKey = publicKey
    ? isSecurityKey(publicKey)
    : /_sk$/i.test(path.basename(filePath, path.extname(filePath)));
  let probeKey = null;
  if (encrypted && publicKey && !securityKey) probeKey = probeFromPublic(publicKey);

  return {
    path: filePath,
    displayPath: displayKeyPath(filePath, home),
    pem,
    loose,
    encrypted,
    securityKey,
    publicBlob: publicBlob(publicKey || privateKey),
    privateKey,
    probeKey,
  };
}

function orderKeyAttempts({ files, agentKeys, agent, identitiesOnly }) {
  const keys = Array.isArray(agentKeys) ? agentKeys : [];
  const usableFiles = (files || []).filter((file) => file && !file.loose);
  const used = new Set();
  const ordered = [];

  for (const file of usableFiles) {
    if (!file.publicBlob) continue;
    const index = keys.findIndex((key) => blobsEqual(file.publicBlob, publicBlob(key)));
    if (index === -1) continue;
    used.add(index);
    ordered.push(keys[index]);
  }
  if (!identitiesOnly) {
    keys.forEach((key, index) => {
      if (!used.has(index)) ordered.push(key);
    });
  }

  const attempts = [];
  if (agent && ordered.length) {
    attempts.push({
      kind: 'agent',
      agent: new SelectedKeysAgent(agent, ordered),
      keys: ordered,
    });
  }

  for (const file of usableFiles) {
    const inAgent = !!(agent && file.publicBlob && keys.some((key) => (
      blobsEqual(file.publicBlob, publicBlob(key))
    )));
    if (inAgent || file.securityKey) continue;
    if (file.encrypted && file.probeKey) {
      attempts.push({
        kind: 'probe',
        probeKey: file.probeKey,
        pem: file.pem,
        path: file.path,
        displayPath: file.displayPath,
      });
      continue;
    }
    if (file.encrypted && file.pem) {
      attempts.push({
        kind: 'locked',
        pem: file.pem,
        path: file.path,
        displayPath: file.displayPath,
      });
      continue;
    }
    if (file.privateKey) {
      attempts.push({
        kind: 'private',
        key: file.privateKey,
        path: file.path,
        displayPath: file.displayPath,
      });
    }
  }
  return attempts;
}

function listAgentKeys(socketPath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (agent, keys) => {
      if (settled) return;
      settled = true;
      resolve({ agent, keys });
    };
    const timer = setTimeout(() => finish(null, []), 3000);
    let agent;
    try {
      agent = createAgent(socketPath);
    } catch {
      clearTimeout(timer);
      finish(null, []);
      return;
    }
    agent.getIdentities((err, keys) => {
      clearTimeout(timer);
      if (err || !Array.isArray(keys)) finish(null, []);
      else finish(agent, keys.filter((key) => isParsedPublic(key)));
    });
  });
}

function localUserName() {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

function noKeyError(loose) {
  if (loose.length === 1) {
    return `${loose[0].displayPath} can be read by other users, so ssh will not use it.`;
  }
  if (loose.length > 1) {
    return 'SSH key files can be read by other users, so ssh will not use them.';
  }
  return NO_KEY_MESSAGE;
}

async function loadAuthPlan(options = {}) {
  const home = options.home || os.homedir();
  const sshDir = options.sshDir || path.join(home, '.ssh');
  const platform = options.platform || process.platform;
  const ctx = {
    host: options.host || '',
    username: options.username || '',
    port: options.port || 22,
    home,
    localUser: options.localUser || localUserName(),
  };
  const sections = loadConfigSections(path.join(sshDir, 'config'), sshDir, home);
  const selection = resolveIdentitySelection(sections, ctx);
  const candidates = selection.explicit ? selection.identityFiles : defaultIdentityPaths(sshDir);
  const files = [];
  const loose = [];
  for (const filePath of candidates) {
    const inspected = inspectKeyFile(filePath, home, platform);
    if (!inspected) continue;
    if (inspected.loose) loose.push(inspected);
    else files.push(inspected);
  }

  let agent = options.agent || null;
  let agentKeys = Array.isArray(options.agentKeys) ? options.agentKeys : null;
  if (!agentKeys && options.agentSocket) {
    const listed = await listAgentKeys(options.agentSocket);
    agent = listed.agent;
    agentKeys = listed.keys;
  }
  agentKeys = agentKeys || [];

  const attempts = orderKeyAttempts({
    files,
    agentKeys,
    agent,
    identitiesOnly: selection.identitiesOnly,
  });
  return {
    attempts,
    identitiesOnly: selection.identitiesOnly,
    error: attempts.length ? null : noKeyError(loose),
  };
}

async function unlockPrivateKey(pem, requestPassphrase, keyLabel) {
  let wrong = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let answer;
    try {
      answer = await requestPassphrase({ keyLabel, wrong });
    } catch {
      return { cancelled: true };
    }
    if (!answer || answer.cancelled) return { cancelled: true };
    const passphrase = typeof answer.passphrase === 'string' ? answer.passphrase : '';
    let parsed;
    try {
      parsed = utils.parseKey(pem, passphrase);
    } catch (err) {
      parsed = err instanceof Error ? err : new Error(String(err));
    }
    if (!(parsed instanceof Error) && parsed && typeof parsed.isPrivateKey === 'function' && parsed.isPrivateKey()) {
      return { key: parsed };
    }
    wrong = true;
  }
  return { cancelled: true };
}

module.exports = {
  DEFAULT_IDENTITY_NAMES,
  NO_KEY_MESSAGE,
  SelectedKeysAgent,
  resolveAgentSocket,
  friendlyAuthError,
  isProbeAcceptedError,
  displayKeyPath,
  isEncryptedPrivateKey,
  extractOpenSshPublicBlob,
  parseConfigSections,
  resolveIdentitySelection,
  orderKeyAttempts,
  loadAuthPlan,
  unlockPrivateKey,
  globMatch,
};
