// Pure editor decisions shared by the renderer and the SFTP save handler.
// No DOM, SSH, or Docker behavior lives here.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.editorState = api;
})(function () {
  const CONNECTION_LOST_MESSAGE = 'Saving is unavailable because the connection was lost.';

  function classifyNewlines(raw) {
    const text = String(raw == null ? '' : raw);
    let crlf = 0;
    let lf = 0;
    let cr = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          crlf++;
          i++;
        } else {
          cr++;
        }
      } else if (code === 10) {
        lf++;
      }
    }
    if (crlf === 0 && lf === 0 && cr === 0) return 'lf';
    if (crlf >= lf && crlf >= cr) return 'crlf';
    if (cr > lf && cr > crlf) return 'cr';
    return 'lf';
  }

  // Match what a textarea stores: every newline becomes LF.
  function toEditorText(raw) {
    return String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function prepareForSave(text, style) {
    const value = String(text == null ? '' : text);
    if (style === 'crlf') return value.replace(/\n/g, '\r\n');
    if (style === 'cr') return value.replace(/\n/g, '\r');
    return value;
  }

  function hasUnsavedChanges(current, baseline) {
    return current !== baseline;
  }

  function saveAction(current, baseline) {
    return current === baseline ? 'skip' : 'write';
  }

  function sameEditingSession(openKey, currentKey) {
    return !!openKey && openKey === currentKey;
  }

  // Reads that should stay on the existing preview, not the editor.
  function isPreviewOnlyRead(result) {
    if (!result) return false;
    if (result.success === true && result.utf8 === false) return true;
    if (result.success === false) {
      const msg = String(result.error || '');
      if (/binary file/i.test(msg)) return true;
      if (/too large/i.test(msg)) return true;
    }
    return false;
  }

  function assessRemoteChange(input) {
    const opts = input || {};
    if (opts.force === true) return { conflict: false };
    const expectedMtime = opts.expectedMtime;
    const expectedSize = opts.expectedSize;
    const remoteMtime = opts.remoteMtime;
    const remoteSize = opts.remoteSize;
    if (!Number.isFinite(expectedMtime) || !Number.isFinite(expectedSize)
        || !Number.isFinite(remoteMtime) || !Number.isFinite(remoteSize)) {
      return {
        conflict: true,
        error: 'The remote file could not be checked for changes, so it was not overwritten.',
      };
    }
    if (remoteMtime !== expectedMtime || remoteSize !== expectedSize) {
      return {
        conflict: true,
        error: 'The remote file has changed since you opened or last saved it. It was not overwritten.',
      };
    }
    return { conflict: false };
  }

  // Baseline updates only after the server accepts the write.
  function applySaveResult(baseline, current, result) {
    if (!result || result.success !== true) {
      return { baseline, saved: false, mtime: null, size: null };
    }
    return {
      baseline: current,
      saved: true,
      mtime: Number.isFinite(result.mtime) ? result.mtime : null,
      size: Number.isFinite(result.size) ? result.size : null,
    };
  }

  // Shells that can run an in-place write. nologin and false cannot.
  function hasLoginShell(shell) {
    const text = String(shell || '').trim();
    return /\/(?:bash|dash|zsh|ksh|mksh|rksh|fish|tcsh|csh|sh)$/i.test(text);
  }

  function isSafeAccountName(name) {
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(name);
  }

  function parsePasswdEntry(line) {
    const text = String(line || '').trim();
    if (!text) return null;
    const parts = text.split(':');
    if (parts.length < 7 || !isSafeAccountName(parts[0])) return null;
    const uid = Number(parts[2]);
    return {
      name: parts[0],
      uid: Number.isInteger(uid) ? uid : null,
      shell: parts[6] || '',
    };
  }

  function parseAccountFacts(stdout) {
    const facts = { currentUser: '', owner: null, groupMembers: [], uidMin: null };
    const lines = String(stdout || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('CURRENT ')) {
        const name = line.slice('CURRENT '.length).trim();
        facts.currentUser = isSafeAccountName(name) ? name : '';
      } else if (line.startsWith('PASSWD ')) {
        facts.owner = parsePasswdEntry(line.slice('PASSWD '.length));
      } else if (line.startsWith('MEMBER ')) {
        const member = parsePasswdEntry(line.slice('MEMBER '.length));
        if (member) facts.groupMembers.push(member);
      } else if (line.startsWith('UIDMIN ')) {
        const uidMin = Number(line.slice('UIDMIN '.length).trim());
        facts.uidMin = Number.isInteger(uidMin) && uidMin > 0 ? uidMin : null;
      }
    }
    return facts;
  }

  // A login account other than the SSH user. Accounts below UID_MIN are system
  // accounts (no password people use); root is handled by the fallback.
  function isLoginAccount(user, currentUser, uidMin) {
    if (!user || !isSafeAccountName(user.name) || user.name === currentUser) return false;
    if (!hasLoginShell(user.shell)) return false;
    if (Number.isInteger(uidMin) && Number.isInteger(user.uid) && user.uid > 0 && user.uid < uidMin) {
      return false;
    }
    return true;
  }

  // Who can write, from the mode bits. Root is the fallback because root can
  // write a file the SSH user cannot, on any server, without hardcoding one host.
  function chooseWriteAccount(facts) {
    const info = facts || {};
    const mode = Number(info.mode) & 0o777;
    const ownerWrite = (mode & 0o200) !== 0;
    const groupWrite = (mode & 0o020) !== 0;
    const currentUser = info.currentUser || '';
    const uidMin = Number.isInteger(info.uidMin) ? info.uidMin : null;
    const owner = info.owner || null;
    const members = Array.isArray(info.groupMembers) ? info.groupMembers : [];

    if (ownerWrite && isLoginAccount(owner, currentUser, uidMin)) {
      return { username: owner.name, via: 'owner' };
    }
    if (groupWrite) {
      for (let i = 0; i < members.length; i++) {
        if (isLoginAccount(members[i], currentUser, uidMin)) {
          return { username: members[i].name, via: 'group' };
        }
      }
    }
    return { username: 'root', via: 'root' };
  }

  function formatFileMode(mode) {
    const bits = Number(mode) & 0o777;
    const flags = ['r', 'w', 'x'];
    let text = '-';
    for (let i = 0; i < 9; i++) {
      text += (bits & (1 << (8 - i))) !== 0 ? flags[i % 3] : '-';
    }
    return text;
  }

  function elevationPrompt(info) {
    const src = info || {};
    const username = isSafeAccountName(src.writeUser) ? src.writeUser : 'root';
    const current = src.currentUser || 'This account';
    const ownerLabel = src.ownerName
      || (Number.isInteger(src.ownerUid) ? `uid ${src.ownerUid}` : 'another account');
    const mode = src.modeText ? ` (${src.modeText})` : '';
    let lead;
    if (src.writeVia === 'owner') {
      lead = `${current} cannot change this file. ${username} owns it${mode} and can write it.`;
    } else if (src.writeVia === 'group') {
      lead = `${current} cannot change this file${mode}. ${username} can write it through the group permission.`;
    } else {
      lead = `${current} cannot change this file. It is owned by ${ownerLabel}${mode}. ${username} can write it.`;
    }
    return {
      username,
      message: `${lead} Enter that account's password to overwrite the file in place. Change the account if a different user can write it. The owner and permissions stay the same.`,
    };
  }

  function stripTerminal(text) {
    return String(text || '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\r/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  }

  function passwordPromptCount(text) {
    const clean = stripTerminal(text);
    const matches = clean.match(/(?:password|passwort)\s*:/gi);
    return matches ? matches.length : 0;
  }

  function isSuAuthFailure(text) {
    return /authentication failure|incorrect password|auth(?:entication)? failed|(?:^|\n)\s*sorry[,.]?\s*try again/i
      .test(stripTerminal(text));
  }

  function usefulTerminalError(text, marker) {
    const lines = stripTerminal(text).split('\n').map((line) => line.trim()).filter((line) => {
      if (!line) return false;
      if (/^(?:password|passwort)\s*:?\s*$/i.test(line)) return false;
      if (marker && line.includes(marker)) return false;
      if (/records (?:in|out)$/i.test(line)) return false;
      if (/bytes?(?:\s+\(.*\))?\s+copied/i.test(line)) return false;
      return true;
    });
    const message = lines.slice(-4).join(' ').trim();
    return (message || 'The file was not saved.').slice(0, 500);
  }

  return {
    CONNECTION_LOST_MESSAGE,
    classifyNewlines,
    toEditorText,
    prepareForSave,
    hasUnsavedChanges,
    saveAction,
    sameEditingSession,
    isPreviewOnlyRead,
    assessRemoteChange,
    applySaveResult,
    hasLoginShell,
    isSafeAccountName,
    parsePasswdEntry,
    parseAccountFacts,
    chooseWriteAccount,
    formatFileMode,
    elevationPrompt,
    stripTerminal,
    passwordPromptCount,
    isSuAuthFailure,
    usefulTerminalError,
  };
});
