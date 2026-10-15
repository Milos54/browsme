'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../renderer/editor-state');
const docker = require('../docker-files');

const ID = 'abc123abc123';
const OTHER_ID = 'def456def456';
const BACKUP = '/tmp/.ssh-explorer-docker-1-0123456789abcdef';

function textResult(code, stdout, stderr = '') {
  return {
    code,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout == null ? '' : stdout)),
    stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr)),
  };
}

function statLine(size, mtimeMs) {
  const sec = Math.floor(mtimeMs / 1000);
  const ms = mtimeMs % 1000;
  const frac = `${String(ms).padStart(3, '0')}000000`;
  return `${size}|${sec}|2020-01-01 00:00:00.${frac} +0000`;
}

function probeText(state) {
  if (state.type === 'symlink') return 'TYPE symlink\n';
  if (state.type === 'missing') return 'TYPE missing\n';
  if (state.type === 'directory') return 'TYPE directory\n';
  if (state.type === 'special') return 'TYPE special\n';
  const lines = [
    `WRITABLE ${state.writable ? 'yes' : 'no'}`,
    'MOUNTS_BEGIN',
    String(state.mounts || 'overlay / overlay rw,relatime 0 0').trimEnd(),
    'MOUNTS_END',
    `STAT ${statLine(state.bytes.length, state.mtime)}`,
  ];
  if (state.bytes.length > docker.MAX_TEXT_BYTES) lines.push('TYPE toolarge');
  else lines.push('TYPE file');
  return `${lines.join('\n')}\n`;
}

function fakeEnv(options = {}) {
  const state = {
    status: options.status || 'running',
    type: options.type || 'file',
    writable: options.writable !== false,
    bytes: Buffer.from(options.content == null ? 'old\n' : options.content),
    mtime: options.mtime == null ? 1700000000123 : options.mtime,
    mounts: options.mounts || 'overlay / overlay rw,relatime 0 0\n',
    backup: null,
    failWrite: !!options.failWrite,
    failRestore: !!options.failRestore,
    dropAfterWrite: !!options.dropAfterWrite,
    corruptReads: options.corruptReads || 0,
    alive: options.connected !== false,
    missingDocker: !!options.missingDocker,
  };
  const calls = [];
  const sftpWrites = [];
  const env = {
    calls,
    sftpWrites,
    state,
    backupPath: BACKUP,
    connected() {
      return state.alive;
    },
    sftpWrite() {
      sftpWrites.push('called');
      throw new Error('SFTP write handler was called');
    },
    async run(spec) {
      calls.push({
        op: spec.op,
        command: spec.command,
        pty: spec.pty,
        stdin: spec.stdin == null ? null : Buffer.from(spec.stdin),
      });
      assert.equal(spec.pty, false, `${spec.op} must not request a PTY`);
      if (spec.op === 'sftp-writefile' || /\bsftp\b/i.test(spec.command)) env.sftpWrite();
      if (state.missingDocker) {
        return textResult(127, '', 'bash: docker: command not found');
      }
      if (spec.op === 'status') return textResult(0, `${state.status}\n`);
      if (spec.op === 'probe') return textResult(0, probeText(state));
      if (spec.op === 'backup') {
        state.backup = Buffer.from(state.bytes);
        return textResult(0, '');
      }
      if (spec.op === 'chmod') return textResult(0, '');
      if (spec.op === 'backup-size') return textResult(0, `${state.backup.length}\n`);
      if (spec.op === 'write') {
        assert.equal(spec.command.includes('<'), false);
        if (state.dropAfterWrite) {
          state.alive = false;
          return textResult(-1, '', 'Not connected');
        }
        if (state.failWrite) return textResult(1, '', 'Permission denied');
        state.bytes = Buffer.from(spec.stdin);
        state.mtime += 1000;
        return textResult(0, '');
      }
      if (spec.op === 'read') {
        if (state.corruptReads > 0) {
          state.corruptReads -= 1;
          return textResult(0, Buffer.from('WRONG'), probeText(state));
        }
        return textResult(0, state.bytes, probeText(state));
      }
      if (spec.op === 'restore') {
        if (state.failRestore) return textResult(1, '', 'restore failed');
        state.bytes = Buffer.from(state.backup);
        state.mtime += 1000;
        return textResult(0, '');
      }
      if (spec.op === 'host-cat') return textResult(0, state.backup || Buffer.alloc(0));
      if (spec.op === 'cleanup') return textResult(0, '');
      throw new Error(`unexpected op ${spec.op}`);
    },
  };
  return env;
}

function baseRequest(extra) {
  return {
    containerId: ID,
    path: '/etc/my file.txt',
    content: 'hello',
    expectedMtime: 1700000000123,
    expectedSize: Buffer.byteLength('old\n'),
    ...extra,
  };
}

test('escapeSh quotes spaces and single quotes', () => {
  assert.equal(docker.escapeSh('/tmp/my file.txt'), "'/tmp/my file.txt'");
  assert.equal(docker.escapeSh("/tmp/a'b.txt"), "'/tmp/a'\\''b.txt'");
});

test('container file commands quote paths and do not request a terminal or root', () => {
  const path = "/tmp/a'b file.txt";
  const write = docker.inPlaceWriteSpec(ID, path, Buffer.from('hello'));
  assert.equal(write.pty, false);
  assert.equal(write.stdin.toString('utf8'), 'hello');
  assert.equal(write.stdin.length, 5);
  assert.equal(write.command.includes(path), false);
  assert.match(write.command, /^docker exec -i '/);
  assert.equal(write.command.includes('-u '), false);
  assert.equal(/(^|\s)-t(\s|$)/.test(write.command), false);
  assert.equal(write.command.includes('<'), false);

  const withNewline = docker.inPlaceWriteSpec(ID, '/etc/hosts', Buffer.from('hello\n'));
  assert.equal(withNewline.stdin.toString('utf8'), 'hello\n');
  assert.equal(withNewline.stdin.length, 6);

  const empty = docker.inPlaceWriteSpec(ID, '/etc/hosts', Buffer.from(''));
  assert.equal(empty.stdin.length, 0);

  const crlf = docker.inPlaceWriteSpec(ID, '/etc/hosts', Buffer.from('a\r\nb'));
  assert.equal(crlf.stdin.toString('utf8'), 'a\r\nb');

  const body = docker.metadataBody('/tmp/my file.txt', 'stdout', docker.MAX_TEXT_BYTES);
  assert.ok(body.startsWith("p='/tmp/my file.txt'"));
  const quotedBody = docker.metadataBody("/tmp/a'b.txt", 'stdout', docker.MAX_TEXT_BYTES);
  assert.ok(quotedBody.startsWith("p='/tmp/a'\\''b.txt'"));

  const probe = docker.probeSpec(ID, '/tmp/my file.txt');
  assert.equal(probe.pty, false);
  assert.equal(probe.stdin, null);
  assert.ok(probe.command.includes(docker.escapeSh(docker.metadataBody('/tmp/my file.txt', 'stdout', docker.MAX_TEXT_BYTES))));

  const backup = docker.dockerCpToHostSpec(ID, '/var/opt/my file.txt', BACKUP);
  assert.match(backup.command, /^umask 077 && docker cp '/);
  assert.ok(backup.command.includes(`'${ID}:/var/opt/my file.txt'`));
  assert.ok(backup.command.endsWith(`'${BACKUP}'`));

  const restore = docker.restoreSpec(ID, '/var/opt/my file.txt', BACKUP);
  assert.equal(restore.pty, false);
  assert.match(restore.command, /^docker exec -i '/);
  assert.ok(restore.command.includes(` < '${BACKUP}'`));
  assert.equal(restore.command.includes('docker cp'), false);

  const mode = docker.chmodBackupSpec(BACKUP);
  assert.match(mode.command, /^chmod 600 -- '/);
  assert.equal(mode.command.includes('644'), false);
  assert.equal(mode.command.includes('chown'), false);
});

test('invalid container ids and unsafe paths are rejected', () => {
  assert.equal(docker.validateContainerId(ID).ok, true);
  assert.equal(docker.validateContainerId(ID.toUpperCase()).id, ID);
  assert.equal(docker.validateContainerId('a'.repeat(64)).ok, true);
  for (const bad of ['', 'abc', 'abc123;rm', 'abc123abc123; touch /tmp/x', '../etc', 'not a container', '$(id)', `${ID.slice(0, 6)}\n${ID.slice(6)}`]) {
    assert.equal(docker.validateContainerId(bad).ok, false, bad);
  }

  assert.equal(docker.validateContainerPath('/tmp/foo..bar').ok, true);
  assert.equal(docker.validateContainerPath('/etc/my file.txt').ok, true);
  for (const bad of ['etc/passwd', '/tmp/../etc/passwd', '/../etc/passwd', '/tmp/./secret', '/tmp//secret', '/tmp/\0hidden', '/tmp/a\nb', '']) {
    assert.equal(docker.validateContainerPath(bad).ok, false, bad);
  }

  assert.throws(() => docker.probeSpec('abc;rm -rf /', '/etc/hosts'));
  assert.throws(() => docker.inPlaceWriteSpec(ID, '/tmp/../etc/passwd', Buffer.from('x')));
});

test('file metadata parsing keeps sub-second precision when stat provides it', () => {
  assert.equal(docker.mtimeMsFromStat('10', '2020-01-01 00:00:10.123456789 +0000'), 10123);
  assert.equal(docker.mtimeMsFromStat('10', '2020-01-01 00:00:10 +0000'), 10000);
  assert.equal(docker.mtimeMsFromStat('10', '2020-01-01 00:00:10.000000000 +0000'), 10000);
  assert.equal(docker.parseStatLine('4|1700000000|2020-01-01 00:00:00.123000000 +0000').mtime, 1700000000123);
  assert.equal(docker.parseStatLine('4|1700000000|2020-01-01 00:00:00.123000000 +0000').size, 4);
  assert.equal(docker.parseStatLine('nope'), null);

  const mounts = [
    'overlay / overlay rw,relatime 0 0',
    'overlay /etc overlay ro,nosuid 0 0',
    'tmpfs /mnt/my\\040disk tmpfs ro 0 0',
  ].join('\n');
  assert.equal(docker.readOnlyFromMounts(mounts, '/home/a'), 'no');
  assert.equal(docker.readOnlyFromMounts(mounts, '/etc/nginx.conf'), 'yes');
  assert.equal(docker.readOnlyFromMounts(mounts, '/mnt/my disk/note'), 'yes');
  assert.equal(docker.readOnlyFromMounts('', '/etc/hosts'), 'unknown');

  const parsed = docker.parseProbe([
    'WRITABLE yes',
    'MOUNTS_BEGIN',
    mounts,
    'MOUNTS_END',
    'STAT 4|1700000000|2020-01-01 00:00:00.123000000 +0000',
    'TYPE file',
  ].join('\n'), '/etc/nginx.conf');
  assert.equal(parsed.type, 'file');
  assert.equal(parsed.writable, true);
  assert.equal(parsed.readonly, 'yes');
  assert.equal(parsed.size, 4);
  assert.equal(parsed.mtime, 1700000000123);
  assert.notEqual(parsed.mtime, 0);
});

test('symlinks and unsupported file types are not editable', () => {
  assert.equal(docker.classifyMetadata({ type: 'symlink' }, { forWrite: true }).symlink, true);
  assert.equal(docker.classifyMetadata({ type: 'symlink' }, { forWrite: false }).ok, false);
  assert.match(docker.classifyMetadata({ type: 'special' }).error, /regular files/i);
  assert.match(docker.classifyMetadata({ type: 'directory' }).error, /regular files/i);
  assert.equal(docker.classifyMetadata({
    type: 'file', mtime: 10, size: 2, writable: false, readonly: 'no',
  }, { forWrite: false }).ok, true);
  assert.match(docker.classifyMetadata({
    type: 'file', mtime: 10, size: 2, writable: false, readonly: 'no',
  }, { forWrite: true }).error, /Permission denied/);
  assert.match(docker.classifyMetadata({
    type: 'file', mtime: 10, size: 2, writable: true, readonly: 'yes',
  }, { forWrite: true }).error, /read-only/i);

  const binary = docker.decodeUtf8Text(Buffer.from([0x68, 0x00, 0x69]));
  assert.equal(binary.ok, false);
  assert.equal(binary.reason, 'binary');
  const bad = docker.decodeUtf8Text(Buffer.from([0xff, 0xfe]));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'encoding');
  assert.equal(docker.decodeUtf8Text(Buffer.from('ok\n')).text, 'ok\n');
});

test('editor routes container saves away from SFTP and keeps host saves on SFTP', () => {
  const hostKey = editor.editingSessionKey('user@host:22', { kind: 'sftp' });
  const dockerKey = editor.editingSessionKey('user@host:22', { kind: 'docker', containerId: 'ABC123ABC123' });
  const otherKey = editor.editingSessionKey('user@host:22', { kind: 'docker', containerId: OTHER_ID });
  assert.equal(hostKey, 'user@host:22');
  assert.equal(dockerKey, 'user@host:22|docker:abc123abc123');
  assert.notEqual(hostKey, dockerKey);
  assert.notEqual(dockerKey, otherKey);
  assert.equal(editor.editingSessionKey('user@host:22', { kind: 'docker', containerId: 'nope' }), '');
  assert.equal(editor.saveRoute('docker'), 'docker-writefile');
  assert.equal(editor.saveRoute('sftp'), 'sftp-writefile');
  assert.equal(editor.saveRoute(undefined), 'sftp-writefile');
  assert.equal(docker.guardWriteChannel('sftp', { path: '/etc/hosts', content: 'a' }).ok, true);
  assert.equal(docker.guardWriteChannel('sftp', { containerId: ID, path: '/etc/hosts', content: 'a' }).ok, false);
  assert.equal(docker.guardWriteChannel('docker', { path: '/etc/hosts', content: 'a' }).ok, false);
  assert.equal(docker.guardWriteChannel('docker', { containerId: ID, path: '/etc/hosts', content: 'a' }).ok, true);

  const changed = editor.assessRemoteChange({
    expectedMtime: 10000,
    expectedSize: 2,
    remoteMtime: 10123,
    remoteSize: 2,
    force: false,
  });
  assert.equal(changed.conflict, true);
  const sameSecond = editor.assessRemoteChange({
    expectedMtime: 10000,
    expectedSize: 2,
    remoteMtime: 10000,
    remoteSize: 2,
    force: false,
  });
  assert.equal(sameSecond.conflict, false);
  const forced = editor.assessRemoteChange({
    expectedMtime: 10000,
    expectedSize: 2,
    remoteMtime: 10123,
    remoteSize: 2,
    force: true,
  });
  assert.equal(forced.conflict, false);
  assert.equal(editor.isPreviewOnlyRead({
    success: false,
    error: 'This file is not valid UTF-8 text, so it was not opened in the editor.',
  }), true);
});

test('docker save writes exact bytes on a non-PTY stream and never calls SFTP', async () => {
  const env = fakeEnv();
  const result = await docker.saveContainerFile(env, baseRequest());
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(result.size, 5);
  assert.notEqual(result.mtime, 1700000000123);
  assert.equal(env.state.bytes.toString('utf8'), 'hello');
  assert.equal(env.sftpWrites.length, 0);

  const write = env.calls.find((call) => call.op === 'write');
  assert.ok(write);
  assert.equal(write.pty, false);
  assert.equal(write.stdin.toString('utf8'), 'hello');
  assert.match(write.command, /^docker exec -i '/);
  assert.equal(write.command.includes('docker cp'), false);
  assert.equal(env.calls.some((call) => call.op === 'sftp-writefile'), false);
  assert.ok(env.calls.some((call) => call.op === 'cleanup'));
  const chmod = env.calls.find((call) => call.op === 'chmod');
  assert.match(chmod.command, /^chmod 600 -- '/);
  for (const call of env.calls) {
    assert.equal(call.pty, false);
    assert.equal(/chown|sudo|-u root|chmod 777/.test(call.command), false);
  }
});

test('a detected conflict does not write unless overwrite is explicit', async () => {
  const blocked = fakeEnv();
  const conflict = await docker.saveContainerFile(blocked, baseRequest({ expectedMtime: 1 }));
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.success, false);
  assert.equal(blocked.calls.some((call) => call.op === 'write'), false);
  assert.equal(blocked.calls.some((call) => call.op === 'backup'), false);
  assert.equal(blocked.state.bytes.toString('utf8'), 'old\n');
  assert.equal(blocked.sftpWrites.length, 0);

  const forced = fakeEnv();
  const overwritten = await docker.saveContainerFile(forced, baseRequest({ expectedMtime: 1, force: true }));
  assert.equal(overwritten.success, true);
  assert.equal(forced.state.bytes.toString('utf8'), 'hello');
  assert.equal(forced.calls.filter((call) => call.op === 'write').length, 1);
  assert.equal(forced.sftpWrites.length, 0);
});

test('symlink, permission, read-only, and stopped container saves do not change the file', async () => {
  const link = fakeEnv({ type: 'symlink', content: 'secret' });
  const linkResult = await docker.saveContainerFile(link, baseRequest({ expectedSize: 6 }));
  assert.equal(linkResult.success, false);
  assert.equal(linkResult.symlink, true);
  assert.equal(link.calls.some((call) => call.op === 'write'), false);
  assert.equal(link.state.bytes.toString('utf8'), 'secret');

  const denied = fakeEnv({ writable: false });
  const deniedResult = await docker.saveContainerFile(denied, baseRequest());
  assert.match(deniedResult.error, /Permission denied/);
  assert.equal(deniedResult.needsElevation, undefined);
  assert.equal(denied.calls.some((call) => call.op === 'write'), false);

  const readonly = fakeEnv({ mounts: 'overlay / overlay ro,relatime 0 0\n' });
  const readonlyResult = await docker.saveContainerFile(readonly, baseRequest());
  assert.match(readonlyResult.error, /read-only/i);
  assert.equal(readonly.calls.some((call) => call.op === 'write'), false);

  const stopped = fakeEnv({ status: 'exited' });
  const stoppedResult = await docker.saveContainerFile(stopped, baseRequest());
  assert.match(stoppedResult.error, /not running/i);
  assert.equal(stopped.calls.some((call) => call.op === 'probe'), false);
  assert.equal(stopped.calls.some((call) => call.op === 'write'), false);
});

test('a failed write restores the backup and a dropped connection stays uncertain', async () => {
  const failed = fakeEnv({ failWrite: true });
  const failedResult = await docker.saveContainerFile(failed, baseRequest());
  assert.equal(failedResult.success, false);
  assert.equal(failedResult.recovered, true);
  assert.match(failedResult.error, /Permission denied/);
  assert.match(failedResult.error, /restored/);
  assert.equal(failed.state.bytes.toString('utf8'), 'old\n');
  assert.equal(failed.sftpWrites.length, 0);
  assert.ok(failed.calls.some((call) => call.op === 'restore'));
  assert.equal(failed.calls.find((call) => call.op === 'restore').command.includes('docker cp'), false);

  const mismatch = fakeEnv({ corruptReads: 1 });
  const mismatchResult = await docker.saveContainerFile(mismatch, baseRequest());
  assert.equal(mismatchResult.success, false);
  assert.equal(mismatchResult.recovered, true);
  assert.match(mismatchResult.error, /did not match/);
  assert.equal(mismatch.state.bytes.toString('utf8'), 'old\n');

  const unrestored = fakeEnv({ failWrite: true, failRestore: true });
  const unrestoredResult = await docker.saveContainerFile(unrestored, baseRequest());
  assert.equal(unrestoredResult.success, false);
  assert.equal(unrestoredResult.recovered, false);
  assert.equal(unrestoredResult.uncertain, true);

  const dropped = fakeEnv({ dropAfterWrite: true });
  const droppedResult = await docker.saveContainerFile(dropped, baseRequest());
  assert.equal(droppedResult.success, false);
  assert.equal(droppedResult.uncertain, true);
  assert.match(droppedResult.error, /may be incomplete or unchanged/);
  assert.equal(dropped.calls.some((call) => call.op === 'restore'), false);
  assert.equal(dropped.sftpWrites.length, 0);
});

test('invalid targets and host payloads never start a container write', async () => {
  const env = fakeEnv();
  const badId = await docker.saveContainerFile(env, baseRequest({ containerId: 'abc;rm' }));
  assert.equal(badId.success, false);
  const badPath = await docker.saveContainerFile(env, baseRequest({ path: '/tmp/../etc/passwd' }));
  assert.equal(badPath.success, false);
  const hostPayload = await docker.saveContainerFile(env, { path: '/etc/hosts', content: 'x' });
  assert.equal(hostPayload.success, false);
  assert.equal(env.calls.length, 0);
  assert.equal(env.sftpWrites.length, 0);
});

test('container reads return text, size, and mtime, and do not follow symlinks', async () => {
  const env = fakeEnv({ content: 'hello\n' });
  const result = await docker.readContainerFile(env, { containerId: ID, path: '/etc/my file.txt' });
  assert.equal(result.success, true);
  assert.equal(result.content, 'hello\n');
  assert.equal(result.size, 6);
  assert.equal(result.mtime, 1700000000123);
  assert.equal(result.utf8, true);
  assert.equal(result.editable, true);
  assert.equal(env.calls[0].pty, false);
  assert.equal(env.calls[0].stdin, null);

  const link = fakeEnv({ type: 'symlink', content: 'secret-target' });
  const linkResult = await docker.readContainerFile(link, { containerId: ID, path: '/etc/motd' });
  assert.equal(linkResult.success, false);
  assert.equal(linkResult.symlink, true);
  assert.equal(linkResult.content, undefined);
  assert.match(linkResult.error, /symbolic link/i);

  const binary = fakeEnv({ content: Buffer.from([0x68, 0x00, 0x69]) });
  const binaryResult = await docker.readContainerFile(binary, { containerId: ID, path: '/etc/motd' });
  assert.equal(binaryResult.success, false);
  assert.equal(binaryResult.utf8, false);
  assert.equal(binaryResult.editable, false);
  assert.match(binaryResult.error, /Binary file/);

  const encoded = fakeEnv({ content: Buffer.from([0xff, 0xfe]) });
  const encodedResult = await docker.readContainerFile(encoded, { containerId: ID, path: '/etc/motd' });
  assert.equal(encodedResult.success, false);
  assert.match(encodedResult.error, /not valid UTF-8/);

  const stats = await docker.statContainerFile(env, { containerId: ID, path: '/etc/my file.txt' });
  assert.equal(stats.success, true);
  assert.equal(stats.type, 'file');
  assert.equal(stats.mtime, 1700000000123);
  assert.equal(stats.symlink, false);
});
