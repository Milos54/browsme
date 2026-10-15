'use strict';

const crypto = require('crypto');
const { assessRemoteChange, CONNECTION_LOST_MESSAGE } = require('./renderer/editor-state');

// Container text edits go through `docker exec` on the SSH host.
// Writes stream bytes on a non-PTY stdin channel. They are not atomic:
// `cat > file` truncates the destination before the new bytes arrive.
// A mode-600 backup on the remote host is used to restore that previous
// content when a write or verification fails. A dropped connection can
// still leave the container file incomplete.

const MAX_TEXT_BYTES = 1024 * 1024;
const DOCKER_MISSING_MSG = 'No docker containers found or maybe no docker installed';
const BACKUP_PATH_RE = /^\/tmp\/\.ssh-explorer-docker-\d+-[a-f0-9]{16}$/;

function escapeSh(p) {
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

function isDockerMissingOutput(text) {
  return /\bdocker(?:\.exe)?:\s*(?:command\s+)?not found\b/i.test(String(text || ''));
}

function dockerMissingResult() {
  return { success: false, unavailable: true, error: DOCKER_MISSING_MSG };
}

function validateContainerId(id) {
  const text = String(id || '').trim();
  if (!/^[a-f0-9]{12,64}$/i.test(text)) {
    return { ok: false, error: 'The container id is not valid.' };
  }
  return { ok: true, id: text.toLowerCase() };
}

function validateContainerPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'A container file path is required.' };
  }
  if (filePath.length > 4096 || filePath.includes('\0') || /[\r\n]/.test(filePath)) {
    return { ok: false, error: 'The container path is not safe to use.' };
  }
  if (!filePath.startsWith('/')) {
    return { ok: false, error: 'Container paths must be absolute.' };
  }
  const parts = filePath.split('/');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '.' || part === '..') {
      return { ok: false, error: 'Container paths cannot contain . or .. segments.' };
    }
    if (part === '' && i !== 0) {
      return { ok: false, error: 'The container path is not safe to use.' };
    }
  }
  return { ok: true, path: filePath };
}

function isManagedBackupPath(filePath) {
  return typeof filePath === 'string' && BACKUP_PATH_RE.test(filePath);
}

function makeBackupPath() {
  return `/tmp/.ssh-explorer-docker-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function guardWriteChannel(channel, payload) {
  const docker = !!(payload && (payload.containerId || payload.kind === 'docker'));
  if (channel === 'sftp' && docker) {
    return { ok: false, error: 'Container files cannot be saved through the server file writer.' };
  }
  if (channel === 'docker' && !docker) {
    return { ok: false, error: 'A container id is required for container file saves.' };
  }
  return { ok: true };
}

function spec(op, command, stdin = null) {
  return {
    op,
    command,
    pty: false,
    stdin,
    timeoutMs: 30000,
  };
}

function requireTarget(containerId, filePath) {
  const id = validateContainerId(containerId);
  if (!id.ok) throw new Error(id.error);
  const path = validateContainerPath(filePath);
  if (!path.ok) throw new Error(path.error);
  return { containerId: id.id, filePath: path.path };
}

function requireBackup(backupPath) {
  if (!isManagedBackupPath(backupPath)) throw new Error('The backup path is not valid.');
  return backupPath;
}

// Metadata is printed as text. `stream` is 'stderr' when file bytes occupy stdout.
function metadataBody(filePath, stream, maxBytes) {
  const checked = validateContainerPath(filePath);
  if (!checked.ok) throw new Error(checked.error);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid size limit.');
  const suf = stream === 'stderr' ? ' >&2' : '';
  const p = escapeSh(checked.path);
  return [
    `p=${p}`,
    `if [ -L "$p" ]; then printf "%s\\n" "TYPE symlink"${suf}; exit 0; fi`,
    `if [ ! -e "$p" ]; then printf "%s\\n" "TYPE missing"${suf}; exit 0; fi`,
    `if [ -d "$p" ]; then printf "%s\\n" "TYPE directory"${suf}; exit 0; fi`,
    `if [ ! -f "$p" ]; then printf "%s\\n" "TYPE special"${suf}; exit 0; fi`,
    `if [ -w "$p" ]; then printf "%s\\n" "WRITABLE yes"${suf}; else printf "%s\\n" "WRITABLE no"${suf}; fi`,
    'if [ -r /proc/mounts ]; then',
    `  printf "%s\\n" "MOUNTS_BEGIN"${suf}`,
    `  cat /proc/mounts${suf}`,
    `  printf "%s\\n" "MOUNTS_END"${suf}`,
    'else',
    `  printf "%s\\n" "MOUNTS_UNAVAILABLE"${suf}`,
    'fi',
    'stat_line=$(stat -c \'%s|%Y|%y\' -- "$p" 2>/dev/null || stat -c \'%s|%Y|\' -- "$p" 2>/dev/null || true)',
    `if [ -z "$stat_line" ]; then printf "%s\\n" "TYPE nometa"${suf}; exit 0; fi`,
    `printf "%s\\n" "STAT $stat_line"${suf}`,
    'size=${stat_line%%|*}',
    `case "$size" in ''|*[!0-9]*) printf "%s\\n" "TYPE nometa"${suf}; exit 0 ;; esac`,
    `if [ "$size" -gt ${maxBytes} ]; then printf "%s\\n" "TYPE toolarge"${suf}; exit 0; fi`,
    `printf "%s\\n" "TYPE file"${suf}`,
  ].join('\n');
}

function dockerExecCommand(containerId, script, stdin) {
  const id = validateContainerId(containerId);
  if (!id.ok) throw new Error(id.error);
  const flag = stdin ? '-i ' : '';
  return `docker exec ${flag}${escapeSh(id.id)} /bin/sh -c ${escapeSh(script)}`;
}

function statusSpec(containerId) {
  const id = validateContainerId(containerId);
  if (!id.ok) throw new Error(id.error);
  return spec(
    'status',
    `docker inspect --format '{{.State.Status}}' ${escapeSh(id.id)}`
  );
}

function probeSpec(containerId, filePath) {
  const target = requireTarget(containerId, filePath);
  const script = metadataBody(target.filePath, 'stdout', MAX_TEXT_BYTES);
  return spec('probe', dockerExecCommand(target.containerId, script, false));
}

function readSpec(containerId, filePath) {
  const target = requireTarget(containerId, filePath);
  const script = `${metadataBody(target.filePath, 'stderr', MAX_TEXT_BYTES)}\ncat -- "$p"`;
  return spec('read', dockerExecCommand(target.containerId, script, false));
}

// In-place write as the container's configured user. No `-u`, no PTY.
// The remote shell does not add bytes; `stdin` is the exact file image.
function inPlaceWriteSpec(containerId, filePath, buffer) {
  const target = requireTarget(containerId, filePath);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  const script = `cat > ${escapeSh(target.filePath)}`;
  return spec('write', dockerExecCommand(target.containerId, script, true), data);
}

function dockerCpToHostSpec(containerId, filePath, backupPath) {
  const target = requireTarget(containerId, filePath);
  const backup = requireBackup(backupPath);
  const source = `${target.containerId}:${target.filePath}`;
  return spec(
    'backup',
    `umask 077 && docker cp ${escapeSh(source)} ${escapeSh(backup)}`
  );
}

function chmodBackupSpec(backupPath) {
  const backup = requireBackup(backupPath);
  return spec('chmod', `chmod 600 -- ${escapeSh(backup)}`);
}

function backupSizeSpec(backupPath) {
  const backup = requireBackup(backupPath);
  return spec('backup-size', `wc -c < ${escapeSh(backup)}`);
}

function hostCatSpec(backupPath) {
  const backup = requireBackup(backupPath);
  return spec('host-cat', `cat -- ${escapeSh(backup)}`);
}

// Restore streams the host backup into the same in-place `cat >` write.
// This is not `docker cp`, which would replace the inode and can chown it to root.
function restoreSpec(containerId, filePath, backupPath) {
  const target = requireTarget(containerId, filePath);
  const backup = requireBackup(backupPath);
  const script = `cat > ${escapeSh(target.filePath)}`;
  return spec(
    'restore',
    `docker exec -i ${escapeSh(target.containerId)} /bin/sh -c ${escapeSh(script)} < ${escapeSh(backup)}`
  );
}

function cleanupSpec(backupPath) {
  const backup = requireBackup(backupPath);
  return spec('cleanup', `rm -f -- ${escapeSh(backup)}`);
}

// `%y` supplies a fractional second when GNU stat (or busybox) provides one.
// Those digits are kept as milliseconds. Without a fraction the value is
// whole seconds. Conflict checks compare this number and the byte size, so a
// change that leaves both the same is not detected.
function mtimeMsFromStat(epochSeconds, human) {
  const text = String(epochSeconds == null ? '' : epochSeconds).trim();
  if (!/^\d+$/.test(text)) return null;
  const sec = Number(text);
  if (!Number.isSafeInteger(sec)) return null;
  let ms = sec * 1000;
  const match = String(human || '').match(/\.(\d{1,9})/);
  if (match) {
    const millis = Number(match[1].padEnd(9, '0').slice(0, 3));
    if (Number.isInteger(millis)) ms += millis;
  }
  return Number.isSafeInteger(ms) ? ms : null;
}

function parseStatLine(line) {
  const match = String(line || '').match(/^(\d+)\|(\d+)\|(.*)$/);
  if (!match) return null;
  const size = Number(match[1]);
  const mtime = mtimeMsFromStat(match[2], match[3]);
  if (!Number.isInteger(size) || size < 0 || mtime == null) return null;
  return { size, mtime };
}

function unescapeMount(value) {
  return String(value || '')
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\');
}

function mountCovers(mountPoint, filePath) {
  if (!mountPoint || !filePath || !filePath.startsWith('/')) return false;
  if (mountPoint === '/') return true;
  return filePath === mountPoint || filePath.startsWith(`${mountPoint}/`);
}

function readOnlyFromMounts(mountsText, filePath) {
  const text = String(mountsText || '');
  if (!text.trim() || !filePath) return 'unknown';
  let bestLen = -1;
  let bestOpts = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 4) continue;
    const mountPoint = unescapeMount(fields[1]);
    if (!mountCovers(mountPoint, filePath)) continue;
    if (mountPoint.length > bestLen) {
      bestLen = mountPoint.length;
      bestOpts = fields[3];
    }
  }
  if (bestOpts == null) return 'unknown';
  return bestOpts.split(',').includes('ro') ? 'yes' : 'no';
}

function parseProbe(text, filePath) {
  const lines = String(text || '').split(/\r?\n/);
  const meta = {
    type: '',
    writable: null,
    readonly: 'unknown',
    size: null,
    mtime: null,
    mounts: null,
  };
  let collecting = false;
  const mountLines = [];
  let sawMounts = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === 'MOUNTS_BEGIN') {
      collecting = true;
      sawMounts = true;
      mountLines.length = 0;
      continue;
    }
    if (line === 'MOUNTS_END') {
      collecting = false;
      meta.mounts = mountLines.join('\n');
      continue;
    }
    if (collecting) {
      mountLines.push(line);
      continue;
    }
    if (line === 'MOUNTS_UNAVAILABLE') {
      meta.mounts = null;
      meta.readonly = 'unknown';
      continue;
    }
    if (line.startsWith('TYPE ')) meta.type = line.slice(5).trim();
    else if (line.startsWith('WRITABLE ')) meta.writable = line.slice(9).trim() === 'yes';
    else if (line.startsWith('STAT ')) {
      const parsed = parseStatLine(line.slice(5).trim());
      if (parsed) {
        meta.size = parsed.size;
        meta.mtime = parsed.mtime;
      }
    }
  }
  if (sawMounts && typeof meta.mounts === 'string') {
    meta.readonly = readOnlyFromMounts(meta.mounts, filePath);
  }
  return meta;
}

function tooLargeMessage(size) {
  if (Number.isFinite(size)) {
    return `File is too large to preview (${(size / 1024 / 1024).toFixed(1)} MB). Limit is 1 MB.`;
  }
  return 'File is too large to preview. Limit is 1 MB.';
}

function classifyMetadata(meta, options) {
  const forWrite = !!(options && options.forWrite);
  const info = meta || {};
  if (info.type === 'symlink') {
    return { ok: false, symlink: true, error: 'This is a symbolic link. It was not opened or changed.' };
  }
  if (info.type === 'missing') {
    return { ok: false, error: 'The file no longer exists in the container.' };
  }
  if (info.type === 'directory' || info.type === 'special') {
    return { ok: false, error: 'Only regular files can be edited.' };
  }
  if (info.type === 'nometa' || !info.type) {
    return { ok: false, error: 'The file modification time is unavailable, so it cannot be edited safely.' };
  }
  if (info.type === 'toolarge') {
    return { ok: false, error: tooLargeMessage(info.size) };
  }
  if (info.type !== 'file') {
    return { ok: false, error: 'Only regular files can be edited.' };
  }
  if (!Number.isFinite(info.mtime) || !Number.isFinite(info.size)) {
    return { ok: false, error: 'The file modification time is unavailable, so it cannot be edited safely.' };
  }
  if (forWrite && info.readonly === 'yes') {
    return { ok: false, error: 'The container filesystem is read-only. The file was not changed.' };
  }
  if (forWrite && info.writable !== true) {
    return { ok: false, error: 'Permission denied. The current container user cannot write this file. The editor does not switch to root.' };
  }
  return { ok: true };
}

function decodeUtf8Text(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (data.includes(0)) return { ok: false, reason: 'binary' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { ok: true, text };
  } catch (err) {
    if (err && err.name === 'TypeError') return { ok: false, reason: 'encoding' };
    return { ok: true, text: data.toString('utf8') };
  }
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.alloc(0);
}

function combinedOutput(result) {
  return `${textOf(result && result.stderr)}\n${textOf(result && result.stdout)}`;
}

function missingFrom(result) {
  if (isDockerMissingOutput(combinedOutput(result))) return dockerMissingResult();
  return null;
}

function describeFailure(result, fallback) {
  const raw = combinedOutput(result);
  if (isDockerMissingOutput(raw)) return DOCKER_MISSING_MSG;
  if (/no such container|no such object/i.test(raw)) {
    return 'The container is no longer available. The file was not saved.';
  }
  if (/is not running|container .* not running/i.test(raw)) {
    return 'The container is not running. The file was not saved.';
  }
  if (/read-only file system/i.test(raw)) {
    return 'The container filesystem is read-only. The file was not changed.';
  }
  if (/permission denied/i.test(raw)) {
    return 'Permission denied. The current container user cannot write this file. The editor does not switch to root.';
  }
  if (/no such file/i.test(raw)) return 'The file no longer exists in the container.';
  const line = textOf(result && result.stderr).trim().split(/\r?\n/).filter(Boolean).pop();
  return (line || fallback || 'The container command failed.').slice(0, 500);
}

function lostBeforeWrite() {
  return { success: false, error: CONNECTION_LOST_MESSAGE };
}

function lostDuringWrite() {
  return {
    success: false,
    uncertain: true,
    error: 'Saving stopped because the connection dropped. Your text is still in the editor. The file in the container may be incomplete or unchanged.',
  };
}

function usableEnv(env) {
  return !!(env && typeof env.run === 'function' && typeof env.connected === 'function' && env.connected());
}

async function runMetadata(env, containerId, filePath) {
  const result = await env.run(probeSpec(containerId, filePath));
  if (!env.connected()) return { error: lostBeforeWrite() };
  const missing = missingFrom(result);
  if (missing) return { error: missing };
  const meta = parseProbe(textOf(result.stdout), filePath);
  if (result.code !== 0 && !meta.type) {
    return { error: { success: false, error: describeFailure(result, 'The container file could not be checked.') } };
  }
  return { meta };
}

function chooseBackupPath(env) {
  if (isManagedBackupPath(env && env.backupPath)) return env.backupPath;
  const generated = makeBackupPath();
  return isManagedBackupPath(generated) ? generated : null;
}

async function cleanupBackup(env, backupPath, state) {
  if (!state || state.cleaned || !backupPath || !env.connected()) return;
  state.cleaned = true;
  try {
    await env.run(cleanupSpec(backupPath));
  } catch {
    // The container result is more important than removing the temp file.
  }
}

async function tryRestore(env, containerId, filePath, backupPath) {
  if (!env.connected()) return false;
  try {
    const restored = await env.run(restoreSpec(containerId, filePath, backupPath));
    if (!env.connected() || !restored || restored.code !== 0) return false;
    const original = await env.run(hostCatSpec(backupPath));
    const check = await env.run(readSpec(containerId, filePath));
    if (!env.connected() || !original || original.code !== 0 || !check || check.code !== 0) return false;
    return asBuffer(check.stdout).equals(asBuffer(original.stdout));
  } catch {
    return false;
  }
}

function restoreReport(recovered, matched) {
  if (matched && recovered) {
    return {
      success: false,
      recovered: true,
      error: 'The saved contents did not match what was written. The previous version was restored. Your text is still in the editor.',
    };
  }
  if (recovered) {
    return {
      success: false,
      recovered: true,
      error: 'The save failed and the previous version was restored. Your text is still in the editor.',
    };
  }
  return {
    success: false,
    recovered: false,
    uncertain: true,
    error: 'The save failed and the previous version could not be restored. The file in the container may be incomplete. Your text is still in the editor.',
  };
}

async function saveContainerFile(env, request) {
  const guard = guardWriteChannel('docker', request || {});
  if (!guard.ok) return { success: false, error: guard.error };

  const idCheck = validateContainerId(request && request.containerId);
  if (!idCheck.ok) return { success: false, error: idCheck.error };
  const pathCheck = validateContainerPath(request && request.path);
  if (!pathCheck.ok) return { success: false, error: pathCheck.error };
  if (!request || typeof request.content !== 'string') {
    return { success: false, error: 'File content must be text.' };
  }
  if (request.content.includes('\0')) {
    return { success: false, error: 'The text contains binary data and was not saved.' };
  }
  const buffer = Buffer.from(request.content, 'utf8');
  if (buffer.length > MAX_TEXT_BYTES) {
    return { success: false, error: 'File is too large to save. Limit is 1 MB.' };
  }
  if (!usableEnv(env)) return lostBeforeWrite();

  const containerId = idCheck.id;
  const filePath = pathCheck.path;
  const status = await env.run(statusSpec(containerId));
  if (!env.connected()) return lostBeforeWrite();
  const statusMissing = missingFrom(status);
  if (statusMissing) return statusMissing;
  if (!status || status.code !== 0) {
    return { success: false, error: describeFailure(status, 'The container is no longer available. The file was not saved.') };
  }
  if (textOf(status.stdout).trim() !== 'running') {
    return { success: false, error: 'The container is not running. The file was not saved.' };
  }

  const probed = await runMetadata(env, containerId, filePath);
  if (probed.error) return probed.error;
  const verdict = classifyMetadata(probed.meta, { forWrite: true });
  if (!verdict.ok) return { success: false, error: verdict.error, symlink: !!verdict.symlink };

  const change = assessRemoteChange({
    expectedMtime: request.expectedMtime,
    expectedSize: request.expectedSize,
    remoteMtime: probed.meta.mtime,
    remoteSize: probed.meta.size,
    force: request.force === true,
  });
  if (change.conflict) {
    return {
      success: false,
      conflict: true,
      error: change.error,
      mtime: probed.meta.mtime,
      size: probed.meta.size,
    };
  }

  const backupPath = chooseBackupPath(env);
  if (!backupPath) {
    return { success: false, error: 'A backup path could not be prepared, so the file was not changed.' };
  }

  const state = { cleaned: false, writeStarted: false };
  try {
    const copied = await env.run(dockerCpToHostSpec(containerId, filePath, backupPath));
    if (!env.connected()) return lostBeforeWrite();
    const copyMissing = missingFrom(copied);
    if (copyMissing) {
      await cleanupBackup(env, backupPath, state);
      return copyMissing;
    }
    if (!copied || copied.code !== 0) {
      await cleanupBackup(env, backupPath, state);
      return { success: false, error: 'A backup could not be created, so the file was not changed.' };
    }

    const mode = await env.run(chmodBackupSpec(backupPath));
    if (!env.connected()) return lostBeforeWrite();
    if (!mode || mode.code !== 0) {
      await cleanupBackup(env, backupPath, state);
      return { success: false, error: 'A backup could not be protected, so the file was not changed.' };
    }

    const sized = await env.run(backupSizeSpec(backupPath));
    if (!env.connected()) return lostBeforeWrite();
    const backupSize = parseInt(textOf(sized && sized.stdout).trim(), 10);
    if (!sized || sized.code !== 0 || backupSize !== probed.meta.size) {
      await cleanupBackup(env, backupPath, state);
      return { success: false, error: 'The backup did not match the container file, so the file was not changed.' };
    }

    state.writeStarted = true;
    const wrote = await env.run(inPlaceWriteSpec(containerId, filePath, buffer));
    if (!env.connected()) return lostDuringWrite();
    const writeMissing = missingFrom(wrote);
    if (writeMissing || !wrote || wrote.code !== 0) {
      const recovered = await tryRestore(env, containerId, filePath, backupPath);
      await cleanupBackup(env, backupPath, state);
      if (writeMissing) return writeMissing;
      const described = describeFailure(wrote, 'The file could not be saved.');
      const report = restoreReport(recovered, false);
      return {
        ...report,
        error: recovered
          ? `${described} The previous version was restored. Your text is still in the editor.`
          : `${described} The previous version could not be restored. The file in the container may be incomplete. Your text is still in the editor.`,
      };
    }

    const verified = await env.run(readSpec(containerId, filePath));
    if (!env.connected()) return lostDuringWrite();
    const actual = asBuffer(verified && verified.stdout);
    const bytesMatch = !!(verified && verified.code === 0 && actual.equals(buffer));
    if (!bytesMatch) {
      const recovered = await tryRestore(env, containerId, filePath, backupPath);
      await cleanupBackup(env, backupPath, state);
      return restoreReport(recovered, true);
    }

    let after = parseProbe(textOf(verified.stderr), filePath);
    if (!Number.isFinite(after.mtime) || after.size !== buffer.length) {
      const again = await runMetadata(env, containerId, filePath);
      if (again.meta) after = again.meta;
    }
    await cleanupBackup(env, backupPath, state);
    if (!Number.isFinite(after.mtime)) {
      return {
        success: false,
        verified: true,
        error: 'The new contents were written and verified, but the file time could not be read. Your text is still in the editor. Open the file again before saving further changes.',
      };
    }
    return {
      success: true,
      mtime: after.mtime,
      size: Number.isFinite(after.size) ? after.size : buffer.length,
      verified: true,
    };
  } catch (err) {
    let recovered = false;
    if (state.writeStarted && env.connected()) {
      recovered = await tryRestore(env, containerId, filePath, backupPath);
    }
    await cleanupBackup(env, backupPath, state);
    if (state.writeStarted && !env.connected()) return lostDuringWrite();
    if (!state.writeStarted) {
      return { success: false, error: (err && err.message) || 'The file was not changed.' };
    }
    return restoreReport(recovered, false);
  } finally {
    await cleanupBackup(env, backupPath, state);
  }
}

async function readContainerFile(env, request) {
  const idCheck = validateContainerId(request && request.containerId);
  if (!idCheck.ok) return { success: false, error: idCheck.error };
  const pathCheck = validateContainerPath(request && request.path);
  if (!pathCheck.ok) return { success: false, error: pathCheck.error };
  if (!usableEnv(env)) return { success: false, error: 'Not connected' };

  const result = await env.run(readSpec(idCheck.id, pathCheck.path));
  if (!env.connected()) return { success: false, error: 'Not connected' };
  const missing = missingFrom(result);
  if (missing) return missing;

  const meta = parseProbe(textOf(result && result.stderr), pathCheck.path);
  const verdict = classifyMetadata(meta, { forWrite: false });
  if (!verdict.ok) {
    return {
      success: false,
      utf8: false,
      editable: false,
      symlink: !!verdict.symlink,
      error: verdict.error,
      size: meta.size,
      mtime: meta.mtime,
    };
  }
  if (!result || result.code !== 0) {
    return { success: false, error: describeFailure(result, 'Cannot read file') };
  }

  const stdout = asBuffer(result.stdout);
  if (stdout.length !== meta.size) {
    return { success: false, error: 'The file changed while it was being read. Open it again.' };
  }
  const decoded = decodeUtf8Text(stdout);
  if (!decoded.ok) {
    return {
      success: false,
      utf8: false,
      editable: false,
      size: meta.size,
      mtime: meta.mtime,
      error: decoded.reason === 'binary'
        ? 'Binary file — cannot preview.'
        : 'This file is not valid UTF-8 text, so it was not opened in the editor.',
    };
  }
  return {
    success: true,
    content: decoded.text,
    size: meta.size,
    mtime: meta.mtime,
    utf8: true,
    editable: true,
    writable: meta.writable === true && meta.readonly !== 'yes',
  };
}

async function statContainerFile(env, request) {
  const idCheck = validateContainerId(request && request.containerId);
  if (!idCheck.ok) return { success: false, error: idCheck.error };
  const pathCheck = validateContainerPath(request && request.path);
  if (!pathCheck.ok) return { success: false, error: pathCheck.error };
  if (!usableEnv(env)) return { success: false, error: 'Not connected' };

  const probed = await runMetadata(env, idCheck.id, pathCheck.path);
  if (probed.error) return probed.error;
  const meta = probed.meta;
  const verdict = classifyMetadata(meta, { forWrite: false });
  if (!verdict.ok) {
    return {
      success: false,
      symlink: !!verdict.symlink,
      type: meta.type || '',
      error: verdict.error,
      size: meta.size,
      mtime: meta.mtime,
    };
  }
  return {
    success: true,
    type: 'file',
    size: meta.size,
    mtime: meta.mtime,
    writable: meta.writable === true,
    readonly: meta.readonly === 'yes',
    editable: true,
    symlink: false,
  };
}

module.exports = {
  MAX_TEXT_BYTES,
  DOCKER_MISSING_MSG,
  CONNECTION_LOST_MESSAGE,
  escapeSh,
  isDockerMissingOutput,
  dockerMissingResult,
  validateContainerId,
  validateContainerPath,
  isManagedBackupPath,
  makeBackupPath,
  guardWriteChannel,
  metadataBody,
  statusSpec,
  probeSpec,
  readSpec,
  inPlaceWriteSpec,
  dockerCpToHostSpec,
  chmodBackupSpec,
  backupSizeSpec,
  hostCatSpec,
  restoreSpec,
  cleanupSpec,
  mtimeMsFromStat,
  parseStatLine,
  unescapeMount,
  readOnlyFromMounts,
  parseProbe,
  classifyMetadata,
  decodeUtf8Text,
  saveContainerFile,
  readContainerFile,
  statContainerFile,
};
