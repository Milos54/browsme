'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const net = require('net');
const { Server, utils } = require('ssh2');
const { SshNav } = require('../ssh-nav');

const STATUS_CODE = utils.sftp.STATUS_CODE;

function listDir(sftp) {
  return new Promise((resolve, reject) => {
    sftp.readdir('/', (err, list) => {
      if (err) reject(err);
      else resolve(list.map((entry) => entry.filename).sort());
    });
  });
}

function waitUntil(fn, ms = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) {
        resolve();
        return;
      }
      if (Date.now() - start > ms) {
        reject(new Error('timed out'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function makeFakeClient(world) {
  return class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.world = world;
      this.opts = null;
      this.connected = false;
      this.ended = false;
      world.clients.push(this);
    }

    connect(opts) {
      this.opts = opts;
      process.nextTick(() => {
        if (this.ended) return;
        if (world.failConnect.has(opts.host)) {
          this.emit('error', new Error('connect failed'));
          return;
        }
        this.connected = true;
        this.emit('ready');
      });
    }

    forwardOut(_src, _srcPort, host, _port, cb) {
      const stream = new EventEmitter();
      stream.destroyed = false;
      stream.destroy = () => {
        stream.destroyed = true;
        stream.emit('close');
      };
      world.streams.push({ from: this.opts && this.opts.host, to: host, stream });
      process.nextTick(() => {
        if (!this.connected || this.ended) cb(new Error('not connected'));
        else cb(null, stream);
      });
    }

    sftp(cb) {
      process.nextTick(() => {
        if (this.ended || !this.connected) {
          cb(new Error('Not connected'));
          return;
        }
        if (world.failSftp.has(this.opts.host)) {
          cb(new Error('sftp failed'));
          return;
        }
        const sftp = {
          host: this.opts.host,
          ended: false,
          _error: null,
          on(event, fn) {
            if (event === 'error') this._error = fn;
          },
          removeAllListeners() {
            this._error = null;
          },
          end() {
            this.ended = true;
          },
          readdir(_path, done) {
            done(null, [{ filename: this.host }]);
          },
        };
        cb(null, sftp);
      });
    }

    end() {
      if (this.ended) return;
      this.ended = true;
      this.connected = false;
      this.emit('end');
      this.emit('close');
    }

    destroy() {
      this.end();
    }
  };
}

function fakeWorld() {
  return { clients: [], streams: [], failConnect: new Set(), failSftp: new Set() };
}

function liveClients(world) {
  return world.clients.filter((client) => !client.ended);
}

test('fake clients: exit from the first server disconnects like Disconnect', async () => {
  const world = fakeWorld();
  const nav = new SshNav({ Client: makeFakeClient(world) });
  const connected = await nav.connect({ host: 'A', port: 22, username: 'userA', password: 'pw' });
  assert.equal(connected.success, true);
  assert.equal(nav.sessions.length, 1);
  const client = nav.sessions[0].client;

  const exited = await nav.exit();
  assert.deepEqual(exited, { success: true, disconnected: true, depth: 0 });
  assert.equal(client.ended, true);
  assert.equal(nav.sshClient, null);
  assert.equal(nav.sftpSession, null);
  assert.equal(nav.jumpClient, null);

  const nav2 = new SshNav({ Client: makeFakeClient(world) });
  await nav2.connect({ host: 'A', port: 22, username: 'userA', password: 'pw' });
  const disconnected = nav2.disconnect();
  assert.deepEqual(disconnected, { success: true });
  assert.equal(nav2.sessions.length, 0);
  assert.equal(nav2.sshClient, null);
  assert.equal(liveClients(world).length, 0);
});

test('fake clients: A to B to C exits one server at a time and reuses the SSH client', async () => {
  const world = fakeWorld();
  const nav = new SshNav({ Client: makeFakeClient(world) });
  await nav.connect({ host: 'A', port: 22, username: 'userA', password: 'pw' });
  const clientA = nav.sshClient;
  const firstSftp = nav.sftpSession;

  const toB = await nav.hop({ host: 'B', port: 22, username: 'userB', password: 'pw' });
  assert.equal(toB.success, true);
  assert.equal(toB.depth, 2);
  assert.equal(firstSftp.ended, true);
  assert.equal(clientA.ended, false);
  assert.equal(nav.sftpSession.host, 'B');

  const toC = await nav.hop({ host: 'C', port: 22, username: 'userC', password: 'pw' });
  assert.equal(toC.depth, 3);
  assert.deepEqual(nav.sessions.map((frame) => frame.host), ['A', 'B', 'C']);

  const backToB = await nav.exit();
  assert.equal(backToB.disconnected, false);
  assert.equal(backToB.connection.host, 'B');
  assert.equal(nav.sshClient.opts.host, 'B');
  assert.equal(nav.sftpSession.host, 'B');
  assert.equal(clientA.ended, false);
  assert.deepEqual(await listDir(nav.sftpSession), ['B']);

  const backToA = await nav.exit();
  assert.equal(backToA.connection.host, 'A');
  assert.equal(nav.sshClient, clientA);
  assert.equal(nav.sftpSession.host, 'A');
  assert.notEqual(nav.sftpSession, firstSftp);
  assert.deepEqual(await listDir(nav.sftpSession), ['A']);
  assert.equal(liveClients(world).length, 1);

  const done = await nav.exit();
  assert.equal(done.disconnected, true);
  assert.equal(liveClients(world).length, 0);
});

test('fake clients: bastion stays connected across hops and is not a navigation step', async () => {
  const world = fakeWorld();
  const nav = new SshNav({ Client: makeFakeClient(world) });
  const connected = await nav.connect({
    host: 'A',
    port: 22,
    username: 'userA',
    password: 'pw',
    jump: { host: 'J', port: 22, username: 'jump', password: 'pw' },
  });
  assert.equal(connected.depth, 1);
  assert.equal(nav.sessions.length, 1);
  assert.equal(nav.sessions[0].host, 'A');
  const bastion = nav.jumpClient;
  assert.equal(bastion.opts.host, 'J');
  assert.equal(bastion.ended, false);

  const onlyExit = await nav.exit();
  assert.equal(onlyExit.disconnected, true);
  assert.equal(bastion.ended, true);

  const again = new SshNav({ Client: makeFakeClient(world) });
  await again.connect({
    host: 'A',
    port: 22,
    username: 'userA',
    password: 'pw',
    jump: { host: 'J', port: 22, username: 'jump', password: 'pw' },
  });
  const jump = again.jumpClient;
  const clientA = again.sshClient;
  await again.hop({ host: 'B', port: 22, username: 'userB', password: 'pw' });
  assert.equal(jump.ended, false);
  assert.equal(clientA.ended, false);
  assert.equal(again.jumpClient, jump);
  assert.deepEqual(again.sessions.map((frame) => frame.host), ['A', 'B']);

  const back = await again.exit();
  assert.equal(back.connection.host, 'A');
  assert.equal(again.sshClient, clientA);
  assert.equal(jump.ended, false);
  assert.deepEqual(await listDir(again.sftpSession), ['A']);

  await again.exit();
  assert.equal(jump.ended, true);
  assert.equal(clientA.ended, true);
  assert.equal(again.jumpClient, null);
});

test('fake clients: a new direct session does not inherit an older chain', async () => {
  const world = fakeWorld();
  const nav = new SshNav({ Client: makeFakeClient(world) });
  await nav.connect({ host: 'A', port: 22, username: 'userA', password: 'pw' });
  const clientA = nav.sshClient;
  await nav.disconnect();
  assert.equal(clientA.ended, true);

  await nav.connect({ host: 'B', port: 22, username: 'userB', password: 'pw' });
  await nav.hop({ host: 'C', port: 22, username: 'userC', password: 'pw' });
  const back = await nav.exit();
  assert.equal(back.connection.host, 'B');
  assert.equal(nav.sessions.length, 1);
  assert.equal(clientA.ended, true);
  assert.deepEqual(await listDir(nav.sftpSession), ['B']);
});

test('fake clients: failed hop keeps the current server, and a dead previous server disconnects', async () => {
  const world = fakeWorld();
  const nav = new SshNav({ Client: makeFakeClient(world) });
  await nav.connect({ host: 'A', port: 22, username: 'userA', password: 'pw' });
  const sftpA = nav.sftpSession;
  world.failConnect.add('B');
  const failed = await nav.hop({ host: 'B', port: 22, username: 'userB', password: 'pw' });
  assert.equal(failed.success, false);
  assert.equal(nav.sessions.length, 1);
  assert.equal(nav.sftpSession, sftpA);
  assert.equal(sftpA.ended, false);
  assert.equal(world.streams.at(-1).stream.destroyed, true);

  world.failConnect.delete('B');
  await nav.hop({ host: 'B', port: 22, username: 'userB', password: 'pw' });
  world.failSftp.add('A');
  const restored = await nav.exit();
  assert.equal(restored.success, false);
  assert.equal(restored.disconnected, true);
  assert.match(restored.error, /SFTP error/);
  assert.equal(nav.sessions.length, 0);
  assert.equal(nav.sshClient, null);
  assert.equal(liveClients(world).length, 0);
});

test('fake clients: disconnect from the newest server closes the whole chain and the bastion', async () => {
  const world = fakeWorld();
  const nav = new SshNav({ Client: makeFakeClient(world) });
  await nav.connect({
    host: 'A',
    port: 22,
    username: 'userA',
    password: 'pw',
    jump: { host: 'J', port: 22, username: 'jump', password: 'pw' },
  });
  await nav.hop({ host: 'B', port: 22, username: 'userB', password: 'pw' });
  await nav.hop({ host: 'C', port: 22, username: 'userC', password: 'pw' });
  assert.equal(liveClients(world).length, 4);
  nav.disconnect();
  assert.equal(liveClients(world).length, 0);
  assert.equal(nav.jumpClient, null);
  assert.equal(nav.sessions.length, 0);
});

function startServer(name, hostKey) {
  const state = {
    name,
    port: 0,
    open: 0,
    accepted: 0,
    tunnels: 0,
    server: null,
  };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      state.open += 1;
      state.accepted += 1;
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map();
          let seq = 1;
          sftp.on('OPENDIR', (reqid) => {
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(seq);
            handles.set(seq, false);
            seq += 1;
            sftp.handle(reqid, handle);
          });
          sftp.on('READDIR', (reqid, handle) => {
            if (!Buffer.isBuffer(handle) || handle.length < 4) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            const id = handle.readUInt32BE(0);
            if (!handles.has(id)) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            if (handles.get(id)) {
              sftp.status(reqid, STATUS_CODE.EOF);
              return;
            }
            handles.set(id, true);
            sftp.name(reqid, [{ filename: name, longname: name, attrs: {} }]);
          });
          sftp.on('CLOSE', (reqid, handle) => {
            if (Buffer.isBuffer(handle) && handle.length >= 4) handles.delete(handle.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
      client.on('tcpip', (accept, _reject, info) => {
        state.tunnels += 1;
        const channel = accept();
        const socket = net.connect(info.destPort, info.destIP);
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          state.tunnels -= 1;
          socket.destroy();
          try { channel.destroy(); } catch { /* already closed */ }
        };
        socket.on('error', finish);
        socket.on('close', finish);
        channel.on('error', finish);
        channel.on('close', finish);
        socket.on('connect', () => {
          channel.pipe(socket);
          socket.pipe(channel);
        });
      });
    });
    client.on('close', () => {
      state.open = Math.max(0, state.open - 1);
    });
  });
  state.server = server;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      resolve(state);
    });
  });
}

function creds(server, username) {
  return { host: '127.0.0.1', port: server.port, username, password: 'test' };
}

test('real ssh2 servers: exit, bastion, disconnect, and a closed previous server', async (t) => {
  const { private: hostKey } = utils.generateKeyPairSync('ed25519');
  const A = await startServer('serverA', hostKey);
  const B = await startServer('serverB', hostKey);
  const C = await startServer('serverC', hostKey);
  const J = await startServer('bastion', hostKey);
  t.after(async () => {
    await Promise.all([A, B, C, J].map((entry) => new Promise((resolve) => {
      entry.server.close(() => resolve());
    })));
  });

  await t.test('direct A: Exit matches Disconnect', async () => {
    const nav = new SshNav();
    try {
      const connected = await nav.connect(creds(A, 'userA'));
      assert.equal(connected.success, true);
      assert.equal(nav.sessions.length, 1);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverA']);
      const exited = await nav.exit();
      assert.deepEqual(exited, { success: true, disconnected: true, depth: 0 });
      assert.equal(nav.sshClient, null);
      assert.equal(nav.jumpClient, null);
      await waitUntil(() => A.open === 0);
    } finally {
      nav.cleanup();
    }

    const nav2 = new SshNav();
    try {
      await nav2.connect(creds(A, 'userA'));
      assert.deepEqual(nav2.disconnect(), { success: true });
      assert.equal(nav2.sessions.length, 0);
      await waitUntil(() => A.open === 0);
    } finally {
      nav2.cleanup();
    }
  });

  await t.test('A then B: Exit restores A without a new connection', async () => {
    const nav = new SshNav();
    try {
      await nav.connect(creds(A, 'userA'));
      const clientA = nav.sshClient;
      const accepted = A.accepted;
      const hopped = await nav.hop(creds(B, 'userB'));
      assert.equal(hopped.success, true);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverB']);
      assert.equal(A.open, 1);
      assert.equal(B.open, 1);

      const back = await nav.exit();
      assert.equal(back.success, true);
      assert.equal(back.connection.username, 'userA');
      assert.equal(back.connection.host, '127.0.0.1');
      assert.equal(back.connection.port, A.port);
      assert.equal(nav.sshClient, clientA);
      assert.equal(A.accepted, accepted);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverA']);
      await waitUntil(() => B.open === 0 && A.tunnels === 0);
      assert.equal(A.open, 1);
    } finally {
      nav.cleanup();
      await waitUntil(() => A.open === 0 && B.open === 0);
    }
  });

  await t.test('A to B to C exits to B, then to A', async () => {
    const nav = new SshNav();
    try {
      await nav.connect(creds(A, 'userA'));
      const clientA = nav.sshClient;
      await nav.hop(creds(B, 'userB'));
      const clientB = nav.sshClient;
      await nav.hop(creds(C, 'userC'));
      assert.deepEqual(await listDir(nav.sftpSession), ['serverC']);

      const toB = await nav.exit();
      assert.equal(toB.connection.port, B.port);
      assert.equal(nav.sshClient, clientB);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverB']);
      await waitUntil(() => C.open === 0);

      const toA = await nav.exit();
      assert.equal(toA.connection.port, A.port);
      assert.equal(nav.sshClient, clientA);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverA']);
      await waitUntil(() => B.open === 0 && A.tunnels === 0);
      assert.equal(A.open, 1);
    } finally {
      nav.cleanup();
      await waitUntil(() => A.open === 0 && B.open === 0 && C.open === 0);
    }
  });

  await t.test('bastion to A: Exit disconnects and does not stop on the bastion', async () => {
    const nav = new SshNav();
    try {
      const connected = await nav.connect({
        ...creds(A, 'userA'),
        jump: creds(J, 'jump'),
      });
      assert.equal(connected.success, true);
      assert.equal(nav.sessions.length, 1);
      assert.equal(nav.sessions[0].username, 'userA');
      assert.notEqual(nav.jumpClient, null);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverA']);
      const exited = await nav.exit();
      assert.equal(exited.disconnected, true);
      assert.equal(nav.jumpClient, null);
      assert.equal(nav.sessions.length, 0);
      await waitUntil(() => A.open === 0 && J.open === 0 && J.tunnels === 0);
    } finally {
      nav.cleanup();
    }
  });

  await t.test('bastion to A, then B: Exit returns to A and keeps the bastion', async () => {
    const nav = new SshNav();
    try {
      await nav.connect({ ...creds(A, 'userA'), jump: creds(J, 'jump') });
      const clientA = nav.sshClient;
      const bastion = nav.jumpClient;
      const acceptedA = A.accepted;
      const acceptedJ = J.accepted;
      await nav.hop(creds(B, 'userB'));
      assert.equal(J.open, 1);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverB']);

      const back = await nav.exit();
      assert.equal(back.disconnected, false);
      assert.equal(back.connection.port, A.port);
      assert.equal(back.connection.username, 'userA');
      assert.equal(nav.sshClient, clientA);
      assert.equal(nav.jumpClient, bastion);
      assert.equal(A.accepted, acceptedA);
      assert.equal(J.accepted, acceptedJ);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverA']);
      await waitUntil(() => B.open === 0 && A.tunnels === 0);
      assert.equal(J.open, 1);
      assert.equal(A.open, 1);

      const done = await nav.exit();
      assert.equal(done.disconnected, true);
      await waitUntil(() => A.open === 0 && J.open === 0 && B.open === 0);
    } finally {
      nav.cleanup();
      await waitUntil(() => A.open === 0 && B.open === 0 && J.open === 0);
    }
  });

  await t.test('Disconnect from C closes A, B, C, and the bastion', async () => {
    const nav = new SshNav();
    try {
      await nav.connect({ ...creds(A, 'userA'), jump: creds(J, 'jump') });
      await nav.hop(creds(B, 'userB'));
      await nav.hop(creds(C, 'userC'));
      assert.equal(J.open, 1);
      assert.equal(A.open, 1);
      assert.equal(B.open, 1);
      assert.equal(C.open, 1);
      assert.deepEqual(nav.disconnect(), { success: true });
      await waitUntil(() => A.open === 0 && B.open === 0 && C.open === 0 && J.open === 0);
      assert.equal(nav.sessions.length, 0);
      assert.equal(nav.jumpClient, null);
    } finally {
      nav.cleanup();
    }
  });

  await t.test('a later direct connection to B does not exit to an older A', async () => {
    const nav = new SshNav();
    try {
      await nav.connect(creds(A, 'userA'));
      await nav.disconnect();
      await waitUntil(() => A.open === 0);
      await nav.connect(creds(B, 'userB'));
      const clientB = nav.sshClient;
      await nav.hop(creds(C, 'userC'));
      const back = await nav.exit();
      assert.equal(back.connection.port, B.port);
      assert.equal(back.connection.username, 'userB');
      assert.equal(nav.sshClient, clientB);
      assert.deepEqual(await listDir(nav.sftpSession), ['serverB']);
      assert.equal(A.open, 0);
    } finally {
      nav.cleanup();
      await waitUntil(() => B.open === 0 && C.open === 0);
    }
  });

  await t.test('Exit falls back to disconnected when the previous server is already closed', async () => {
    const nav = new SshNav();
    try {
      await nav.connect(creds(A, 'userA'));
      await nav.hop(creds(B, 'userB'));
      nav.sessions[0].client.end();
      await waitUntil(() => nav.sessions[0].alive === false);
      const result = await nav.exit();
      assert.equal(result.success, false);
      assert.equal(result.disconnected, true);
      assert.match(result.error, /no longer connected/);
      assert.equal(nav.sessions.length, 0);
      assert.equal(nav.sshClient, null);
      await waitUntil(() => A.open === 0 && B.open === 0);
    } finally {
      nav.cleanup();
      await waitUntil(() => A.open === 0 && B.open === 0);
    }
  });
});
