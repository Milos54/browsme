'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { Server, utils } = require('ssh2');
const { SshNav } = require('../ssh-nav');
const { normalizeMemory } = require('../form-memory');
const {
  parseConfigSections,
  resolveIdentitySelection,
  orderKeyAttempts,
  loadAuthPlan,
  isEncryptedPrivateKey,
  extractOpenSshPublicBlob,
  displayKeyPath,
  unlockPrivateKey,
  globMatch,
} = require('../ssh-keys');

const STATUS_CODE = utils.sftp.STATUS_CODE;

function blobOf(key) {
  return Buffer.from(key.getPublicSSH());
}

function pair() {
  const generated = utils.generateKeyPairSync('ed25519');
  return {
    publicKey: utils.parseKey(generated.public),
    privateKey: utils.parseKey(generated.private),
    publicText: generated.public,
    privateText: generated.private,
  };
}

function fileRecord(keyPair, filePath) {
  return {
    path: filePath,
    displayPath: filePath,
    publicBlob: blobOf(keyPair.publicKey),
    privateKey: keyPair.privateKey,
    encrypted: false,
    loose: false,
    securityKey: false,
    pem: keyPair.privateText,
  };
}

test('host patterns follow the terminal, not every file in .ssh', () => {
  assert.equal(globMatch('*.example.com', 'web.example.com'), true);
  assert.equal(globMatch('*.example.com', 'example.com.evil'), false);
  assert.equal(globMatch('192.168.1.?', '192.168.1.4'), true);

  const sections = parseConfigSections(`
    Host *.example.com
      IdentityFile ~/.ssh/example
      IdentitiesOnly yes
    Host *
      IdentityFile ~/.ssh/id_ed25519
      IdentitiesOnly no
    Host !web.example.com *
      IdentityFile ~/.ssh/other
    Match host web.example.com user alice
      IdentityFile ~/.ssh/%r/matched
    Match exec "true"
      IdentityFile ~/.ssh/from-exec
  `);
  const selected = resolveIdentitySelection(sections, {
    host: 'web.example.com',
    username: 'alice',
    port: 22,
    home: '/Users/alice',
    localUser: 'alice',
  });
  assert.equal(selected.explicit, true);
  assert.equal(selected.identitiesOnly, true);
  assert.deepEqual(selected.identityFiles, [
    '/Users/alice/.ssh/example',
    '/Users/alice/.ssh/id_ed25519',
    '/Users/alice/.ssh/alice/matched',
  ]);
});

test('key order is agent matches, then other agent keys, then files', () => {
  const fileA = pair();
  const fileB = pair();
  const extra = pair();
  const files = [
    fileRecord(fileA, '/keys/a'),
    fileRecord(fileB, '/keys/b'),
  ];
  const agentKeys = [fileB.publicKey, extra.publicKey, fileA.publicKey];

  const open = orderKeyAttempts({
    files,
    agentKeys,
    agent: {},
    identitiesOnly: false,
  });
  assert.equal(open[0].kind, 'agent');
  assert.deepEqual(open[0].keys, [fileA.publicKey, fileB.publicKey, extra.publicKey]);
  assert.equal(open.length, 1);

  const only = orderKeyAttempts({
    files,
    agentKeys,
    agent: {},
    identitiesOnly: true,
  });
  assert.deepEqual(only[0].keys, [fileA.publicKey, fileB.publicKey]);
  assert.equal(only.length, 1);

  const fileOnly = orderKeyAttempts({
    files: [fileRecord(fileA, '/keys/a')],
    agentKeys: [extra.publicKey],
    agent: {},
    identitiesOnly: true,
  });
  assert.equal(fileOnly.length, 1);
  assert.equal(fileOnly[0].kind, 'private');
  assert.equal(fileOnly[0].path, '/keys/a');
});

test('a configured IdentityFile replaces the default names', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-keys-'));
  const sshDir = path.join(home, '.ssh');
  fs.mkdirSync(sshDir, { mode: 0o700 });
  const keys = pair();
  const custom = path.join(sshDir, 'custom_key');
  fs.writeFileSync(custom, keys.privateText, { mode: 0o600 });
  fs.writeFileSync(`${custom}.pub`, keys.publicText, { mode: 0o644 });
  fs.chmodSync(custom, 0o600);
  fs.writeFileSync(path.join(sshDir, 'id_ed25519'), keys.privateText, { mode: 0o600 });
  fs.chmodSync(path.join(sshDir, 'id_ed25519'), 0o600);
  fs.writeFileSync(path.join(sshDir, 'config'), `Host app.example\n  IdentityFile ~/.ssh/custom_key\n`, { mode: 0o600 });

  try {
    const plan = await loadAuthPlan({
      host: 'app.example',
      username: 'alice',
      sshDir,
      home,
      agentSocket: undefined,
    });
    assert.equal(plan.attempts.length, 1);
    assert.equal(plan.attempts[0].kind, 'private');
    assert.equal(plan.attempts[0].path, custom);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a key other users can read is not offered', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-keys-'));
  const sshDir = path.join(home, '.ssh');
  fs.mkdirSync(sshDir, { mode: 0o700 });
  const keys = pair();
  const filePath = path.join(sshDir, 'id_ed25519');
  fs.writeFileSync(filePath, keys.privateText);
  fs.chmodSync(filePath, 0o644);
  try {
    const plan = await loadAuthPlan({
      host: 'app.example',
      username: 'alice',
      sshDir,
      home,
      platform: 'darwin',
    });
    assert.equal(plan.attempts.length, 0);
    assert.match(plan.error, /other users/);
    assert.equal(displayKeyPath(filePath, home), '~/.ssh/id_ed25519');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('form memory remembers Use SSH key and drops the password', () => {
  const memory = normalizeMemory({
    direct: { host: '10.0.0.8', username: 'alice', port: '22', useKey: true, password: 'secret' },
  });
  assert.equal(memory.direct.useKey, true);
  assert.equal(memory.direct.password, undefined);
  assert.equal(normalizeMemory({
    direct: { host: '10.0.0.8', username: 'alice', useKey: 'yes' },
  }).direct.useKey, false);
});

test('a key is offered first and the typed password is sent only when the server asks', async () => {
  const keys = pair();
  const seen = [];
  const nav = new SshNav({
    Client: class FakeClient extends EventEmitter {
      connect(opts) {
        opts.authHandler(null, false, (auth) => {
          opts.offered = auth;
        });
        opts.authHandler(['password'], true, (auth) => {
          opts.afterKey = auth;
        });
        seen.push(opts);
        process.nextTick(() => this.emit('ready'));
      }

      sftp(cb) {
        process.nextTick(() => cb(new Error('stop after auth options')));
      }

      destroy() {}

      end() {}
    },
    loadAuthPlan: async () => ({
      attempts: [{ kind: 'private', key: keys.privateKey, path: '/keys/id_ed25519', displayPath: '~/.ssh/id_ed25519' }],
    }),
    resolveAgentSocket: () => undefined,
  });
  try {
    const result = await nav.connect({
      host: 'app.example',
      username: 'alice',
      password: 'server-secret',
      useKey: true,
    });
    assert.equal(result.success, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].password, undefined);
    assert.equal(seen[0].agent, undefined);
    assert.equal(seen[0].offered.type, 'publickey');
    assert.equal(seen[0].offered.key, keys.privateKey);
    assert.equal(seen[0].offered.passphrase, undefined);
    assert.equal(seen[0].afterKey.type, 'password');
    assert.equal(seen[0].afterKey.password, 'server-secret');
  } finally {
    nav.cleanup();
  }
});

function writeKey(filePath, text, mode) {
  fs.writeFileSync(filePath, text, { mode });
  fs.chmodSync(filePath, mode);
}

function startKeyServer(allowedBlobs, options = {}) {
  const mode = options.mode || 'publickey';
  const accountPassword = options.accountPassword || 'server-secret';
  const methods = [];
  const { private: hostKey } = utils.generateKeyPairSync('ed25519');
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    let passwordAccepted = false;
    let keyAccepted = false;
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      methods.push(ctx.method);
      const keyOk = () => {
        if (ctx.method !== 'publickey' || !ctx.key || !Buffer.isBuffer(ctx.key.data)) return false;
        const allowedKey = allowedBlobs.find((item) => item.blob.equals(ctx.key.data));
        if (!allowedKey) return false;
        if (!ctx.signature) return true;
        return allowedKey.key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true;
      };
      if (mode === 'publickey') {
        if (!keyOk()) {
          ctx.reject(['publickey']);
          return;
        }
        ctx.accept();
        return;
      }
      if (mode === 'key-then-password') {
        if (ctx.method === 'password') {
          if (ctx.password === accountPassword) ctx.accept();
          else ctx.reject(['password'], true);
          return;
        }
        if (!keyAccepted && keyOk()) {
          if (!ctx.signature) {
            ctx.accept();
            return;
          }
          keyAccepted = true;
          ctx.reject(['password'], true);
          return;
        }
        ctx.reject(['publickey']);
        return;
      }
      if (!passwordAccepted) {
        if (ctx.method === 'password' && ctx.password === accountPassword) {
          passwordAccepted = true;
          ctx.reject(['publickey'], true);
          return;
        }
        ctx.reject(['password']);
        return;
      }
      if (!keyOk()) {
        ctx.reject(['publickey']);
        return;
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          sftp.on('OPENDIR', (reqid) => {
            const handle = Buffer.from([0, 0, 0, 1]);
            sftp.handle(reqid, handle);
          });
          sftp.on('READDIR', (reqid) => {
            sftp.status(reqid, STATUS_CODE.EOF);
          });
          sftp.on('CLOSE', (reqid) => {
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, methods });
    });
  });
}

test('an unlocked key connects with no passphrase', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-keys-'));
  const sshDir = path.join(home, '.ssh');
  fs.mkdirSync(sshDir, { mode: 0o700 });
  const keys = pair();
  writeKey(path.join(sshDir, 'id_ed25519'), keys.privateText, 0o600);
  writeKey(path.join(sshDir, 'id_ed25519.pub'), keys.publicText, 0o644);
  const prompts = [];
  const started = await startKeyServer([{ key: keys.publicKey, blob: blobOf(keys.publicKey) }]);
  t.after(() => new Promise((resolve) => started.server.close(() => resolve())));
  const nav = new SshNav({
    sshDir,
    home,
    resolveAgentSocket: () => undefined,
    requestPassphrase: async (prompt) => {
      prompts.push(prompt);
      return { cancelled: true };
    },
  });
  try {
    const result = await nav.connect({
      host: '127.0.0.1',
      port: started.port,
      username: 'alice',
      password: 'not-sent',
      useKey: true,
    });
    assert.equal(result.success, true, result.error);
    assert.equal(prompts.length, 0);
    assert.equal(started.methods.includes('password'), false);
  } finally {
    nav.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

async function connectWithKey(t, mode, password, requestPassword) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-keys-'));
  const sshDir = path.join(home, '.ssh');
  fs.mkdirSync(sshDir, { mode: 0o700 });
  const keys = pair();
  writeKey(path.join(sshDir, 'id_ed25519'), keys.privateText, 0o600);
  writeKey(path.join(sshDir, 'id_ed25519.pub'), keys.publicText, 0o644);
  const asked = [];
  const started = await startKeyServer(
    [{ key: keys.publicKey, blob: blobOf(keys.publicKey) }],
    { mode, accountPassword: 'server-secret' },
  );
  t.after(() => new Promise((resolve) => started.server.close(() => resolve())));
  const nav = new SshNav({
    sshDir,
    home,
    resolveAgentSocket: () => undefined,
    requestPassphrase: async () => ({ cancelled: true }),
    requestPassword: async (prompt) => {
      asked.push(prompt);
      return requestPassword(prompt);
    },
  });
  try {
    const result = await nav.connect({
      host: '127.0.0.1',
      port: started.port,
      username: 'alice',
      password,
      useKey: true,
    });
    return { result, asked, methods: started.methods };
  } finally {
    nav.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('publickey then password uses the typed password after the key', async (t) => {
  const connected = await connectWithKey(t, 'key-then-password', 'server-secret', async () => {
    throw new Error('password prompt was not needed');
  });
  assert.equal(connected.result.success, true, connected.result.error);
  assert.equal(connected.asked.length, 0);
  assert.equal(connected.methods.at(-1), 'password');
  assert.equal(connected.methods[0], 'publickey');
});

test('publickey then password prompts when the password field is blank', async (t) => {
  const connected = await connectWithKey(t, 'key-then-password', '', async (prompt) => {
    assert.equal(prompt.wrong, false);
    assert.equal(prompt.username, 'alice');
    assert.equal(prompt.host, '127.0.0.1');
    return { password: 'server-secret' };
  });
  assert.equal(connected.result.success, true, connected.result.error);
  assert.equal(connected.asked.length, 1);
});

test('a wrong typed password is asked again', async (t) => {
  const connected = await connectWithKey(t, 'key-then-password', 'nope', async (prompt) => {
    assert.equal(prompt.wrong, true);
    return { password: 'server-secret' };
  });
  assert.equal(connected.result.success, true, connected.result.error);
  assert.equal(connected.asked.length, 1);
});

test('password then publickey asks for the password before the key', async (t) => {
  const connected = await connectWithKey(t, 'password-then-key', 'server-secret', async () => {
    throw new Error('password prompt was not needed');
  });
  assert.equal(connected.result.success, true, connected.result.error);
  assert.equal(connected.asked.length, 0);
  assert.equal(connected.methods[0], 'publickey');
  assert.ok(connected.methods.indexOf('password') > 0);
  assert.equal(connected.methods.at(-1), 'publickey');
});

function sshKeygen(args) {
  execFileSync('ssh-keygen', args, { stdio: 'ignore' });
}

test('passphrase is asked only after the server accepts that key', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-keys-'));
  const sshDir = path.join(home, '.ssh');
  fs.mkdirSync(sshDir, { mode: 0o700 });
  const rejectedPath = path.join(sshDir, 'rejected_ed25519');
  const goodPath = path.join(sshDir, 'good_ed25519');
  try {
    sshKeygen(['-q', '-t', 'ed25519', '-f', rejectedPath, '-N', 's3cret']);
  } catch (err) {
    fs.rmSync(home, { recursive: true, force: true });
    t.skip(`ssh-keygen is not available: ${err.message}`);
    return;
  }
  fs.chmodSync(rejectedPath, 0o600);
  const rejectedPub = fs.readFileSync(`${rejectedPath}.pub`);
  const extracted = extractOpenSshPublicBlob(fs.readFileSync(rejectedPath));
  const extractedKey = utils.parseKey(extracted);
  assert.equal(isEncryptedPrivateKey(fs.readFileSync(rejectedPath)), true);
  assert.ok(!(extractedKey instanceof Error));
  assert.ok(blobOf(extractedKey).equals(blobOf(utils.parseKey(rejectedPub))));

  const good = pair();
  writeKey(goodPath, good.privateText, 0o600);
  writeKey(`${goodPath}.pub`, good.publicText, 0o644);
  fs.writeFileSync(path.join(sshDir, 'config'), [
    'Host 127.0.0.1',
    `  IdentityFile ${rejectedPath}`,
    `  IdentityFile ${goodPath}`,
    '  IdentitiesOnly yes',
    '',
  ].join('\n'));

  const prompts = [];
  const started = await startKeyServer([{ key: good.publicKey, blob: blobOf(good.publicKey) }]);
  t.after(() => new Promise((resolve) => started.server.close(() => resolve())));
  const nav = new SshNav({
    sshDir,
    home,
    resolveAgentSocket: () => undefined,
    requestPassphrase: async (prompt) => {
      prompts.push(prompt);
      return { passphrase: 's3cret' };
    },
  });
  try {
    const skipped = await nav.connect({
      host: '127.0.0.1',
      port: started.port,
      username: 'alice',
      useKey: true,
    });
    assert.equal(skipped.success, true, skipped.error);
    assert.equal(prompts.length, 0);
  } finally {
    nav.cleanup();
  }

  const acceptedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-keys-'));
  const acceptedDir = path.join(acceptedHome, '.ssh');
  fs.mkdirSync(acceptedDir, { mode: 0o700 });
  const lockedPath = path.join(acceptedDir, 'id_ed25519');
  sshKeygen(['-q', '-t', 'ed25519', '-f', lockedPath, '-N', 's3cret']);
  fs.chmodSync(lockedPath, 0o600);
  const lockedPub = utils.parseKey(fs.readFileSync(`${lockedPath}.pub`));
  fs.rmSync(`${lockedPath}.pub`);
  const accepted = await startKeyServer([{ key: lockedPub, blob: blobOf(lockedPub) }]);
  t.after(() => new Promise((resolve) => accepted.server.close(() => resolve())));
  const asked = [];
  const lockedNav = new SshNav({
    sshDir: acceptedDir,
    home: acceptedHome,
    resolveAgentSocket: () => undefined,
    requestPassphrase: async (prompt) => {
      asked.push(prompt);
      if (asked.length === 1) return { passphrase: 'wrong' };
      return { passphrase: 's3cret' };
    },
  });
  try {
    const result = await lockedNav.connect({
      host: '127.0.0.1',
      port: accepted.port,
      username: 'alice',
      password: 'server-secret',
      useKey: true,
    });
    assert.equal(result.success, true, result.error);
    assert.equal(asked.length, 2);
    assert.equal(asked[0].keyLabel, '~/.ssh/id_ed25519');
    assert.equal(asked[0].wrong, false);
    assert.equal(asked[1].wrong, true);
  } finally {
    lockedNav.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(acceptedHome, { recursive: true, force: true });
  }
});

test('a wrong passphrase is asked again before the key is used', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-keys-'));
  const filePath = path.join(dir, 'id_ed25519');
  try {
    sshKeygen(['-q', '-t', 'ed25519', '-f', filePath, '-N', 'correct horse']);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    t.skip(`ssh-keygen is not available: ${err.message}`);
    return;
  }
  const prompts = [];
  try {
    const unlocked = await unlockPrivateKey(fs.readFileSync(filePath), async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) return { passphrase: 'nope' };
      return { passphrase: 'correct horse' };
    }, '~/.ssh/id_ed25519');
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].wrong, true);
    assert.equal(unlocked.key.isPrivateKey(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
