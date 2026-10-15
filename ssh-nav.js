'use strict';

const { Client } = require('ssh2');

const READY_TIMEOUT_MS = 15000;

/**
 * Logical SSH navigation, separate from bastion transport.
 *
 * `sessions` is the user's server history. Index 0 is the server reached from
 * the connect form. Later entries were opened with Connect to server. The last
 * entry is the server file browsing uses.
 *
 * `jumpClient` is only the optional bastion from that initial form. It is not
 * a navigation step. Hopping must leave it connected, because the first server
 * (and every server tunneled through it) still depends on it.
 */
class SshNav {
  constructor(options = {}) {
    this.Client = options.Client || Client;
    this.agentSocket = options.agentSocket;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    this.jumpClient = null;
    this.sessions = [];
    this.sshClient = null;
    this.sftpSession = null;
    this.generation = 0;
  }

  connect({ host, port, username, password, jump }) {
    return new Promise((resolve) => {
      this.cleanup();
      const gen = this.generation;
      const targetPort = port || 22;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const establish = (client, sock) => {
        const frame = this.makeFrame(client, host, targetPort, username, sock);
        return this.activateNewFrame(frame, gen).then((activated) => {
          if (activated.stale) {
            finish({ success: false, error: 'Not connected to any server.' });
            return;
          }
          if (!activated.success) {
            if (this.generation === gen) this.cleanup();
            finish({ success: false, error: activated.error });
            return;
          }
          if (this.generation !== gen) {
            this.endFrame(frame);
            finish({ success: false, error: 'Not connected to any server.' });
            return;
          }
          this.sessions.push(frame);
          this.setActive(frame);
          finish({ success: true, depth: this.sessions.length });
        }).catch((err) => {
          if (this.generation === gen) this.cleanup();
          finish({ success: false, error: err.message });
        });
      };

      if (!jump) {
        const client = new this.Client();
        this.silence(client);
        const timeout = setTimeout(() => {
          destroyClient(client);
          finish({ success: false, error: 'Connection timed out after 15 seconds' });
        }, READY_TIMEOUT_MS);

        const onError = (err) => {
          client.removeListener('error', onError);
          clearTimeout(timeout);
          destroyClient(client);
          finish({ success: false, error: err.message });
        };
        client.on('error', onError);
        client.on('ready', () => {
          if (settled || this.generation !== gen) {
            destroyClient(client);
            return;
          }
          clearTimeout(timeout);
          client.removeListener('error', onError);
          establish(client, null);
        });

        try {
          client.connect(this.buildConnectOpts(host, port, username, password));
        } catch (err) {
          clearTimeout(timeout);
          client.removeListener('error', onError);
          finish({ success: false, error: err.message });
        }
        return;
      }

      const jClient = new this.Client();
      this.silence(jClient);
      const timeout = setTimeout(() => {
        destroyClient(jClient);
        if (this.jumpClient === jClient && this.generation === gen) this.cleanup();
        finish({ success: false, error: 'Jump host connection timed out' });
      }, READY_TIMEOUT_MS);

      const onJumpError = (err) => {
        jClient.removeListener('error', onJumpError);
        clearTimeout(timeout);
        destroyClient(jClient);
        if (this.jumpClient === jClient && this.generation === gen) this.cleanup();
        finish({ success: false, error: `Jump host: ${err.message}` });
      };
      jClient.on('error', onJumpError);

      jClient.on('ready', () => {
        if (settled || this.generation !== gen) {
          destroyClient(jClient);
          return;
        }
        clearTimeout(timeout);
        jClient.removeListener('error', onJumpError);
        this.jumpClient = jClient;
        jClient.on('close', () => {
          if (this.jumpClient === jClient) this.jumpClient = null;
        });

        jClient.forwardOut('127.0.0.1', 0, host, targetPort, (err, stream) => {
          if (settled || this.generation !== gen) {
            destroyStream(stream);
            if (!settled) finish({ success: false, error: 'Not connected to any server.' });
            return;
          }
          if (err) {
            this.cleanup();
            finish({ success: false, error: `Tunnel error: ${err.message}` });
            return;
          }

          const tClient = new this.Client();
          this.silence(tClient);
          const tTimeout = setTimeout(() => {
            destroyClient(tClient);
            destroyStream(stream);
            if (this.generation === gen) this.cleanup();
            finish({ success: false, error: 'Target connection timed out' });
          }, READY_TIMEOUT_MS);

          const onTargetError = (targetErr) => {
            tClient.removeListener('error', onTargetError);
            clearTimeout(tTimeout);
            destroyClient(tClient);
            destroyStream(stream);
            if (this.generation === gen) this.cleanup();
            finish({ success: false, error: `Target: ${targetErr.message}` });
          };
          tClient.on('error', onTargetError);
          tClient.on('ready', () => {
            if (settled || this.generation !== gen) {
              destroyClient(tClient);
              destroyStream(stream);
              return;
            }
            clearTimeout(tTimeout);
            tClient.removeListener('error', onTargetError);
            establish(tClient, stream);
          });

          try {
            tClient.connect(this.buildConnectOpts(host, port, username, password, { sock: stream }));
          } catch (connectErr) {
            clearTimeout(tTimeout);
            tClient.removeListener('error', onTargetError);
            destroyClient(tClient);
            destroyStream(stream);
            if (this.generation === gen) this.cleanup();
            finish({ success: false, error: connectErr.message });
          }
        });
      });

      try {
        jClient.connect(this.buildConnectOpts(jump.host, jump.port, jump.username, jump.password));
      } catch (err) {
        clearTimeout(timeout);
        jClient.removeListener('error', onJumpError);
        finish({ success: false, error: `Jump host: ${err.message}` });
      }
    });
  }

  hop({ host, port, username, password }) {
    return new Promise((resolve) => {
      const gen = this.generation;
      const parent = this.currentFrame();
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      if (!parent || !parent.alive || parent.client !== this.sshClient) {
        finish({ success: false, error: 'Not connected to any server.' });
        return;
      }

      const targetPort = port || 22;
      parent.client.forwardOut('127.0.0.1', 0, host, targetPort, (fwdErr, stream) => {
        if (settled || this.generation !== gen || !parent.alive) {
          destroyStream(stream);
          if (!settled) finish({ success: false, error: 'Not connected to any server.' });
          return;
        }
        if (fwdErr) {
          finish({ success: false, error: `Tunnel error: ${fwdErr.message}` });
          return;
        }

        const tClient = new this.Client();
        this.silence(tClient);
        const timeout = setTimeout(() => {
          destroyClient(tClient);
          destroyStream(stream);
          finish({ success: false, error: 'Connection to target timed out.' });
        }, READY_TIMEOUT_MS);

        const onError = (err) => {
          tClient.removeListener('error', onError);
          clearTimeout(timeout);
          destroyClient(tClient);
          destroyStream(stream);
          if (parent.alive && this.generation === gen) this.setActive(parent);
          finish({ success: false, error: err.message });
        };
        tClient.on('error', onError);

        tClient.on('ready', () => {
          if (settled || this.generation !== gen || !parent.alive) {
            clearTimeout(timeout);
            tClient.removeListener('error', onError);
            destroyClient(tClient);
            destroyStream(stream);
            if (!settled) finish({ success: false, error: 'Not connected to any server.' });
            return;
          }
          clearTimeout(timeout);
          tClient.removeListener('error', onError);

          const frame = this.makeFrame(tClient, host, targetPort, username, stream);
          this.activateNewFrame(frame, gen).then((activated) => {
            if (activated.stale || this.generation !== gen) {
              finish({ success: false, error: 'Not connected to any server.' });
              return;
            }
            if (!activated.success || !parent.alive) {
              if (activated.success) this.endFrame(frame);
              if (!parent.alive && this.generation === gen) this.cleanup();
              else if (parent.alive) this.setActive(parent);
              finish({ success: false, error: activated.error || 'Not connected to any server.' });
              return;
            }
            // The parent SSH client stays up: it is the tunnel. Only its
            // browsing channel is released until the user exits back to it.
            this.releaseSftp(parent);
            this.sessions.push(frame);
            this.setActive(frame);
            finish({ success: true, depth: this.sessions.length });
          }).catch((err) => {
            this.endFrame(frame);
            if (parent.alive && this.generation === gen) this.setActive(parent);
            else if (this.generation === gen) this.cleanup();
            finish({ success: false, error: err.message });
          });
        });

        try {
          tClient.connect(this.buildConnectOpts(host, port, username, password, { sock: stream }));
        } catch (err) {
          clearTimeout(timeout);
          tClient.removeListener('error', onError);
          destroyClient(tClient);
          destroyStream(stream);
          finish({ success: false, error: err.message });
        }
      });
    });
  }

  async exit() {
    if (this.sessions.length <= 1) {
      this.cleanup();
      return { success: true, disconnected: true, depth: 0 };
    }

    const gen = this.generation;
    const current = this.sessions.pop();
    this.endFrame(current);

    const previous = this.sessions[this.sessions.length - 1];
    if (!previous || !previous.alive) {
      if (this.generation === gen) this.cleanup();
      return {
        success: false,
        disconnected: true,
        depth: 0,
        error: 'The previous server is no longer connected.',
      };
    }

    const opened = await this.openSftp(previous);
    if (this.generation !== gen) {
      return { success: true, disconnected: true, depth: 0 };
    }
    if (!opened.success || !previous.alive) {
      this.cleanup();
      return {
        success: false,
        disconnected: true,
        depth: 0,
        error: opened.error || 'Could not restore the previous server.',
      };
    }

    this.setActive(previous);
    return {
      success: true,
      disconnected: false,
      depth: this.sessions.length,
      connection: {
        host: previous.host,
        port: previous.port,
        username: previous.username,
      },
    };
  }

  disconnect() {
    this.cleanup();
    return { success: true };
  }

  cleanup() {
    this.generation += 1;
    const frames = this.sessions.splice(0, this.sessions.length);
    for (let i = frames.length - 1; i >= 0; i -= 1) this.endFrame(frames[i]);
    if (this.jumpClient) {
      const bastion = this.jumpClient;
      this.jumpClient = null;
      try { bastion.end(); } catch { /* already closed */ }
    }
    this.sshClient = null;
    this.sftpSession = null;
    this.onChange(null, null);
  }

  currentFrame() {
    return this.sessions.length ? this.sessions[this.sessions.length - 1] : null;
  }

  makeFrame(client, host, port, username, sock) {
    return {
      client,
      sftp: null,
      host,
      port: port || 22,
      username,
      alive: true,
      sock: sock || null,
      onDead: null,
    };
  }

  async activateNewFrame(frame, gen) {
    this.watchFrame(frame);
    const opened = await this.openSftp(frame);
    if (this.generation !== gen) {
      this.endFrame(frame);
      return { stale: true, success: false, error: 'Not connected to any server.' };
    }
    if (!opened.success || !frame.alive) {
      const error = opened.error || 'SFTP error: connection closed';
      this.endFrame(frame);
      return { stale: false, success: false, error };
    }
    return { stale: false, success: true };
  }

  openSftp(frame) {
    return new Promise((resolve) => {
      if (!frame || !frame.alive) {
        resolve({ success: false, error: 'Connection closed.' });
        return;
      }
      if (frame.sftp) this.releaseSftp(frame);

      let settled = false;
      const timer = setTimeout(() => {
        finish({ success: false, error: 'SFTP error: timed out' });
      }, READY_TIMEOUT_MS);
      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }

      try {
        frame.client.sftp((err, sftp) => {
          if (settled) {
            if (sftp) {
              try { sftp.end(); } catch { /* already closed */ }
            }
            return;
          }
          if (!frame.alive) {
            if (sftp) {
              try { sftp.end(); } catch { /* already closed */ }
            }
            finish({ success: false, error: 'Connection closed.' });
            return;
          }
          if (err) {
            finish({ success: false, error: `SFTP error: ${err.message}` });
            return;
          }
          frame.sftp = sftp;
          sftp.on('error', () => {
            if (frame.sftp === sftp) frame.sftp = null;
            if (this.sftpSession === sftp) {
              this.sftpSession = null;
              this.onChange(this.sshClient, null);
            }
          });
          finish({ success: true });
        });
      } catch (err) {
        finish({ success: false, error: `SFTP error: ${err.message}` });
      }
    });
  }

  setActive(frame) {
    if (frame && frame.alive) {
      this.sshClient = frame.client;
      this.sftpSession = frame.sftp || null;
    } else {
      this.sshClient = null;
      this.sftpSession = null;
    }
    this.onChange(this.sshClient, this.sftpSession);
  }

  watchFrame(frame) {
    frame.onDead = () => this.markDead(frame);
    frame.client.on('close', frame.onDead);
    frame.client.on('end', frame.onDead);
    frame.client.on('error', frame.onDead);
  }

  unwatch(frame) {
    if (!frame || !frame.onDead) return;
    frame.client.removeListener('close', frame.onDead);
    frame.client.removeListener('end', frame.onDead);
    frame.client.removeListener('error', frame.onDead);
    frame.onDead = null;
  }

  markDead(frame) {
    const wasCurrent = this.sshClient === frame.client;
    frame.alive = false;
    this.releaseSftp(frame);
    if (wasCurrent) {
      this.sshClient = null;
      this.sftpSession = null;
      this.onChange(null, null);
    }
  }

  releaseSftp(frame) {
    if (!frame || !frame.sftp) return;
    const sftp = frame.sftp;
    frame.sftp = null;
    if (this.sftpSession === sftp) this.sftpSession = null;
    try { sftp.removeAllListeners('error'); } catch { /* already closed */ }
    try { sftp.end(); } catch { /* already closed */ }
  }

  endFrame(frame) {
    if (!frame) return;
    const wasCurrent = this.sshClient === frame.client;
    frame.alive = false;
    this.unwatch(frame);
    this.releaseSftp(frame);
    const sock = frame.sock;
    frame.sock = null;
    if (wasCurrent) {
      this.sshClient = null;
      this.sftpSession = null;
      this.onChange(null, null);
    }
    if (sock) frame.client.once('close', () => destroyStream(sock));
    try { frame.client.end(); } catch { /* already closed */ }
    if (sock && sock.destroyed !== true && frame.client._sock == null) destroyStream(sock);
  }

  silence(client) {
    if (!client || client._sshNavSilenced) return;
    client._sshNavSilenced = true;
    client.on('error', () => {});
  }

  buildConnectOpts(host, port, username, password, extra = {}) {
    const opts = { host, port: port || 22, username, readyTimeout: READY_TIMEOUT_MS, ...extra };
    if (password) opts.password = password;
    else if (this.agentSocket) opts.agent = this.agentSocket;
    return opts;
  }
}

function destroyClient(client) {
  if (!client) return;
  try { client.destroy(); } catch { /* already closed */ }
}

function destroyStream(stream) {
  if (!stream || stream.destroyed) return;
  try { stream.destroy(); } catch { /* already closed */ }
}

module.exports = { SshNav };
