'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'ssh-form-memory.json';

function formMemoryPath(userDataDir) {
  return path.join(userDataDir, FILE_NAME);
}

function cleanText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 22;
  return port;
}

/** Host, username, and port only. Authentication secrets are dropped. */
function sanitizeEndpoint(value) {
  if (!value || typeof value !== 'object') return null;
  const host = cleanText(value.host);
  const username = cleanText(value.username);
  if (!host && !username) return null;
  return { host, username, port: normalizePort(value.port) };
}

function sanitizeDirect(direct) {
  if (!direct || typeof direct !== 'object') return null;
  const host = cleanText(direct.host);
  const username = cleanText(direct.username);
  const jump = sanitizeEndpoint(direct.jump);
  if (!host && !username && !jump) return null;
  return {
    host,
    username,
    port: normalizePort(direct.port),
    jump,
  };
}

function sanitizeHops(hops) {
  const out = {};
  if (!hops || typeof hops !== 'object' || Array.isArray(hops)) return out;
  for (const [key, value] of Object.entries(hops)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const endpoint = sanitizeEndpoint(value);
    if (!endpoint) continue;
    out[key] = endpoint;
  }
  return out;
}

function emptyMemory() {
  return { direct: null, hops: {} };
}

function normalizeMemory(data) {
  if (!data || typeof data !== 'object') return emptyMemory();
  return {
    direct: sanitizeDirect(data.direct),
    hops: sanitizeHops(data.hops),
  };
}

function loadFormMemory(userDataDir) {
  try {
    const raw = fs.readFileSync(formMemoryPath(userDataDir), 'utf8');
    return normalizeMemory(JSON.parse(raw));
  } catch {
    return emptyMemory();
  }
}

function saveFormMemory(userDataDir, data) {
  const normalized = normalizeMemory(data);
  const filePath = formMemoryPath(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
  return normalized;
}

module.exports = {
  FILE_NAME,
  formMemoryPath,
  normalizeMemory,
  loadFormMemory,
  saveFormMemory,
};
