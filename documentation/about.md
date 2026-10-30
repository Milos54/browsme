# SSH Explorer

This file is the project reference for later work in this repository. It describes the application as it is implemented. `taks.txt` is a scratch list and is not a specification. Where that list and the code disagree, follow the code and this document.

Product name: **SSH Explorer**. Package name: `ssh-explorer`. Entry point: `main.js`.

## What the application does

SSH Explorer is a desktop file browser. The user connects to a remote server over SSH and browses that server the way a desktop file manager browses a disk: folders, files, back and forward, rename, copy, delete, and drag-and-drop upload.

After the SSH session is up, three extra surfaces sit on that same connection:

- A text editor for remote files, with save, unsaved-change prompts, and a check that the remote file was not changed by someone else.
- A Docker browser that lists containers on the SSH host and browses a running container’s filesystem with the same folder UI.
- A way to open another server through the current one, then step back to the previous server.

The app does not open a local folder, does not download files to the computer, and does not include a terminal, a “new file” action, or a “new folder” action.

## Protocols

The app speaks **SSH2** to servers, using the `ssh2` npm package. Directory listing, rename, file read, file write, and upload of host files use the **SFTP** subsystem on that connection.

Shell commands on the SSH host use an SSH `exec` channel. Those commands cover home-directory lookup, copy, delete, `sudo` for copy and delete, `su` for saving a file as another account, and every Docker CLI invocation.

Docker is not a separate connection. The app runs the `docker` binary that is installed on the SSH host (`docker ps`, `docker exec`, `docker cp`, `docker inspect`). Container file bytes move on that exec channel. They do not go through SFTP.

There is no HTTP API.

## Runtime and dependencies

| Dependency | Role |
| --- | --- |
| Electron 35 (`electron`) | Desktop shell. Development dependency. `npm start` runs `electron .`. |
| `ssh2` 1.16 | Only runtime dependency. SSH client, SFTP, and the SSH agent client (`ssh2/lib/agent.js`, `ssh2` `utils.parseKey`). |
| `electron-builder` | Windows x64 installer (`nsis`) and portable build. Output directory `dist`. `npm run build`. |
| Node built-ins | `crypto`, `fs`, `path`, `os`, `child_process`. Used for form memory, key loading, temp names, and reading the macOS SSH agent socket. |

Node’s test runner runs the tests: `npm test` is `node --test`. Tests do not launch Electron.

Packaged files are listed in `package.json` under `build.files`: `main.js`, `preload.js`, `ssh-nav.js`, `ssh-keys.js`, `docker-files.js`, `form-memory.js`, `renderer/**`, and `node_modules`. Tests and `taks.txt` are not packaged.

The window is frameless, 1200×780, minimum 800×550, background `#0d1117`. `contextIsolation` is on and `nodeIntegration` is off. The renderer only talks to the main process through `window.api` in `preload.js`.

On macOS, closing the last window does not quit the process (`window-all-closed`). Closing the window still runs `sshNav.cleanup()`.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `main.js` | Electron main process. Window, IPC handlers, SFTP operations, shell exec, Docker IPC, elevated save. Holds the active `sshClient` and `sftpSession`. |
| `preload.js` | `contextBridge` API exposed as `window.api`. |
| `ssh-nav.js` | `SshNav`. Connection stack, bastion tunnel, hop, exit, disconnect, key-login attempts. |
| `ssh-keys.js` | Which SSH keys to try: agent, `~/.ssh/config`, default key filenames, passphrases. |
| `docker-files.js` | Read, stat, and save of a file inside a container. Quoting helper `escapeSh` is also used by host shell commands in `main.js`. |
| `form-memory.js` | Load and save the connect-form history. Strips secrets before writing. |
| `renderer/index.html` | All screens and dialogs. Scripts load in this order: `editor-state.js`, `search.js`, `app.js`. |
| `renderer/app.js` | All renderer behavior. |
| `renderer/editor-state.js` | Shared decisions for newlines, dirty state, save routing, conflict checks, and which account to suggest for `su`. No DOM and no SSH. |
| `renderer/search.js` | Shared decisions for the find bar. No DOM and no SSH. |
| `renderer/style.css` | Layout and theme. |
| `test/` | Node tests for nav, keys, Docker file IO, and search. |

`editor-state.js` and `search.js` are UMD-style. In Electron they attach `window.editorState` and `window.appSearch`. In Node, `require()` returns the same functions. `main.js` and `docker-files.js` require `renderer/editor-state.js` so the save rules in the window and the save rules on the server stay the same.

## Process model

The renderer never holds an SSH socket. A user action calls `window.api.*`, which invokes an IPC channel. The handler in `main.js` uses the active SFTP session or the active SSH client.

`SshNav` owns the sockets. Whenever the active server changes it calls `onChange(client, sftp)`, and `main.js` stores those as `sshClient` and `sftpSession`. File operations always use those two variables, so they always hit the server the user is browsing.

Two exec helpers live in `main.js`:

- `runExec(cmd, stdinData)` sends a shell command as text. Optional stdin is one line plus a newline. Used for `cp`, `rm`, `sudo`, `echo $HOME`, `docker ps`, `docker exec` listings, and account lookup.
- `runRemote(spec)` is binary-safe and refuses a PTY. Used only for container file read and write. Stdin, when present, is the exact file bytes.
- `runPty(cmd, password)` allocates a `vt100` PTY. Used only so `su` can read a password from a terminal. A password piped to `su` without a PTY is ignored.

`escapeSh` wraps a string in single quotes and escapes embedded single quotes. Host paths and container paths that reach a shell go through it.

## Connection model

Two mechanisms both involve “another server”. They are separate objects in `SshNav` and must stay separate.

### Bastion on the first connect form

The connect screen has a checkbox, “Connect via jump host (bastion)”. When it is on, the app:

1. Opens an SSH session to the jump host with that host’s username, port, and password.
2. Calls `forwardOut` from the jump host to the target host and port.
3. Opens the target SSH session on that forwarded stream.
4. Opens SFTP on the target. The target is session index 0. The user browses the target.

`jumpClient` is only that bastion socket. It is not a row in the server history. Exit from the first server disconnects the target and the bastion. The user does not land on the bastion’s filesystem. A later hop leaves the bastion connected, because the first server and every server tunneled through it still depend on it.

The bastion form requires a password. The “Use SSH key” checkbox applies to the target, not to the bastion.

### Connect to server (hop)

The explorer toolbar button “Connect to server” opens the hop dialog. `SshNav.hop` asks the server the user is browsing to `forwardOut` to the new host, connects a new SSH client on that stream, opens SFTP, and pushes a frame onto `sessions`.

The parent SSH client stays open. It is the tunnel. Its SFTP channel is released until the user exits back. `ssh:exit` pops the current frame, closes it, and opens SFTP again on the previous frame. The renderer then loads that server’s `$HOME`.

History is a stack:

- Index 0 is the server reached from the connect form (the target, when a bastion was used).
- Each later entry is one hop.
- The last entry is the server whose files are on screen.
- The Exit button is shown only when the stack has more than one server. Its tooltip names the previous server.
- Exit from the only server is the same as Disconnect.
- Disconnect closes every server in the stack and the bastion.
- A failed hop leaves the current server in place.
- A new connection from the connect form calls `cleanup()` first, so an older chain is not still underneath.
- If the previous server has already died, exit reports that and disconnects.

Each frame records `client`, `sftp`, `host`, `port`, `username`, `alive`, and the forwarded `sock` when there is one. `generation` increments on `cleanup()`. In-flight connect and hop callbacks check it and drop work that belongs to an old connection.

The renderer mirrors the stack in `connectionChain` for the title bar and the Exit button. It does not own the sockets. After a hop the label looks like `user@host (via previousUser@previousHost)`. The first server, when reached through a bastion, looks like `user@host via jumpUser@jumpHost`.

Connect and hop both wait up to 15 seconds (`READY_TIMEOUT_MS`) for the SSH handshake and for SFTP.

### Authentication on a direct connection

The connect form always asks for host, username, and port (default 22).

Without “Use SSH key”, a password is required. `buildConnectOpts` sends that password and does not attach an agent.

With “Use SSH key”, `SshNav.attemptKeyLogin` loads a plan from `ssh-keys.js` and connects with an `authHandler`. The password field stays enabled. Its label says the password is used if the server also asks for it. A typed password is offered only when the server requests `password` or `keyboard-interactive`. If the field was empty, the same dialog that asks for a key passphrase asks for the account password instead. A wrong password is asked again, up to four password prompts. Cancelling either prompt aborts the connect.

Key attempts, in order:

1. SSH agent keys that match the selected identity files, in identity-file order.
2. Any other keys currently in the agent, unless `IdentitiesOnly yes` applies.
3. Key files that are not already in the agent.

Agent sockets:

- Windows: `\\.\pipe\openssh-ssh-agent`.
- Any platform: `SSH_AUTH_SOCK` when it is set.
- macOS, when the variable is missing: `launchctl getenv SSH_AUTH_SOCK`. This second lookup runs at connect time so an app launched from Finder can still see the agent.

Identity selection reads `~/.ssh/config` (or the directory passed in tests):

- `Host` patterns, including `*` and `!` exclusions.
- `Match` with `all`, `host`, `user`, and `localuser` only. Any other `Match` criterion makes that block not apply.
- `IdentityFile`, with `~`, `%h`, `%p`, `%r`, `%d`, `%u`, and `%%` expanded. `IdentityFile none` is skipped and still counts as an explicit configuration, so the default names are not added.
- `IdentitiesOnly yes|no`. The first matching value wins.
- `Include`, relative to the ssh directory, including globs, up to 8 levels, with cycles ignored.

If the config names no identity file, the defaults are `id_rsa`, `id_ecdsa`, `id_ecdsa_sk`, `id_ed25519`, and `id_ed25519_sk`.

On platforms other than Windows, a key file whose mode is readable or writable by group or other (`mode & 0o077`) is refused and is not offered. One such file produces an error that names the path. Several produce a generic error. If nothing usable remains, the error is: “No SSH key found for this host. ssh checks the agent, IdentityFile in ~/.ssh/config, and the default keys in ~/.ssh.”

Encrypted private keys are detected for OpenSSH (`openssh-key-v1`, cipher other than `none`), PEM `Proc-Type: 4,ENCRYPTED`, `BEGIN ENCRYPTED PRIVATE KEY`, and PuTTY keys whose `Encryption` is not `none`. The public half is taken from the sibling `.pub` file or from the public blob inside an OpenSSH private key. The app offers that public key first. Only after the server accepts it does the app ask for the passphrase (`ssh:passphrase-request` / `ssh:passphrase-reply`). A wrong passphrase is asked again. The passphrase is used to decrypt the key in memory and is not stored.

Security keys (`sk-` key types, or a filename ending in `_sk` when the type cannot be parsed) are not unlocked from the file. They are used only when the agent already has them.

Hop authentication is narrower. `hop` calls `buildConnectOpts` only. A password in the hop dialog is sent as the password. A blank hop password attaches the SSH agent socket and does not run the `~/.ssh/config` identity plan, does not unlock key files, and does not show the passphrase dialog. The hop dialog text says a blank password uses key auth. That means the agent.

## Feature: connect screen and form memory

**What it does.** The first screen collects host, username, port, password, optional bastion fields, and the SSH-key checkbox. After a successful connect the app runs `echo $HOME` on the target and opens that directory. If home cannot be read it opens `/`.

**Dependency.** `ssh2` for the session. `form-memory.js` plus Electron `app.getPath('userData')` for the history file. `ssh-keys.js` when “Use SSH key” is checked.

**How it is implemented.** IPC: `ssh:connect`, `ssh:homedir`, `form-memory:load`, `form-memory:save`, `form-memory:flush`.

The history file is `ssh-form-memory.json` in the Electron user-data directory. It has two parts:

- `direct` — the last values from the first screen: host, username, port, `useKey`, and the bastion host, username, and port when the bastion checkbox was on.
- `hops` — a map from `username@host:port` of a server the user was browsing to the last hop destination they opened from that server (host, username, port).

`normalizeMemory` drops anything that is not those fields. Passwords are never written. The write is a temp file in the same directory followed by `rename`, so a crash mid-write does not leave a half file.

The renderer keeps the same data in `lastDirectConnect` and `lastHopFromServer`. Typing in the connect form updates `direct` and saves about 150 ms later. A successful connect or hop, and `beforeunload`, flush immediately with the synchronous IPC channel. On startup the connect form is filled from `direct`. Password fields are cleared. The hop dialog is filled only when `hops` has an entry for the server currently on screen. A server that has never been used as a hop source gets an empty hop form. The first screen and the hop dialog do not share one saved record.

## Feature: folder browsing

**What it does.** Shows the remote directory as a list (default) or a grid. Folders are listed before files. Names sort with `localeCompare`, base sensitivity. The toolbar has back, forward, up, and refresh. A breadcrumb jumps to an ancestor. The status bar shows the connection and the item count. Double-click or Enter opens a folder or a file. Up is disabled at `/`.

**Dependency.** An active SFTP session (`ssh:readdir`). Inside a container, `ssh:docker-readdir` instead. The renderer’s `currentPath`, `navHistory`, and `historyIndex` are local to the current server or container view and are cleared on connect, hop, server exit, and entering or leaving a container.

**How it is implemented.** `sftp.readdir` maps each entry to `{ name, isDirectory, isSymlink, size, mtime, permissions }`. `.` and `..` are removed. Mode bits `S_IFDIR` and `S_IFLNK` come from `attrs.mode`.

Symlinks get a second pass: `sftp.stat` follows the link and sets `isDirectory` from the target, and `sftp.readlink` stores `symlinkTarget`. If the target’s basename is also an entry in the same directory, that entry gets `linkedAs`, an array of symlink names. The UI draws those names as badges (`→ name`). The names `prod`, `production`, `live`, `current`, `stable`, and `release` use a stronger badge style. A symlink’s own target path is not printed on the link row. The link uses a link icon.

A symlink to a directory is opened as a directory. A symlink that is not a directory is not opened.

Back and forward walk `navHistory` without pushing a new entry. Any other navigation pushes, and drops the forward stack first.

List rows show an icon, the name, the size of files, and the modification date. Grid rows show a large icon and the name. Icons are chosen from the extension in `getFileIcon`. Dates use `mtime * 1000`. Container listings set `mtime` to 0, so those rows have no date. `permissions` is returned by SFTP and is not shown in the list.

Keyboard, when a row is focused and no dialog is open:

- Enter activates the row.
- Up and Down move the selection. In grid view, Up and Down move to the nearest row visually above or below.
- Tab and Shift+Tab move between rows and do not leave the list.
- Escape clears the selection.

Rows use `tabIndex = -1`, so they are not in the normal tab order until one is focused. Clicking outside the list clears the selection.

## Feature: type-ahead

**What it does.** Typing a letter while the explorer is showing, and focus is not in a text field, moves the selection the way a Windows folder does.

**Dependency.** The current rendered rows. No IPC. Disabled while a modal is open, while the editor is open, and while Ctrl, Alt, or Meta is held.

**How it is implemented.** `resolveTypeAhead` in `renderer/app.js`, timeout `TYPE_AHEAD_MS` (1000). Matching is case-insensitive with `toLocaleLowerCase` and uses the start of the name.

- The first letter selects the next name that starts with it, wrapping through the list.
- The same letter again, within one second, walks the next name that starts with that letter, then wraps.
- A different letter within one second extends the prefix (`a` then `p` looks for `ap`). If the current name already matches the longer prefix, the selection stays.
- If the longer prefix matches nothing, the selection stays and the query is left as it was.
- After one second the buffer resets and the next letter is a new single-character search.

## Feature: find

**What it does.** Ctrl+F on Windows and Linux, and Cmd+F on macOS, opens a find bar. In a folder it filters names. In the editor it highlights matches in the file, including text that has not been saved. Enter and Shift+Enter move to the next and previous match only while the find field itself is focused, so Enter still opens a file and still inserts a newline in the editor. Escape closes the bar. The match count reads `3 of 12`, or “No matches”.

**Dependency.** `renderer/search.js`. No extra package. The folder filter uses the files already loaded. The editor search uses the textarea value. The query is kept in memory for the session (`findState`). It is not written to disk. Closing the bar keeps the query and stops filtering. Changing directory closes the bar and keeps the query, so the next Ctrl+F restores it. Reopening in the editor reuses that same query.

**How it is implemented.** `handleFindKeydown` runs in the capture phase and stops the event so Chromium’s own find does not open and so Ctrl+F is not treated as a save or an editor exit. `isFindShortcut` requires F with Ctrl (or Meta on a Mac platform string) and rejects Alt, Shift, and IME composition.

Folder search is a case-insensitive substring on `file.name`. Order stays folders-first, then name. Hits are wrapped in `<mark class="find-hit">`. An empty result shows “No matching files or folders” instead of the empty-folder message. The status bar counts matching items.

Editor search finds the same substring in the buffer. Highlights are absolutely positioned divs in `#editor-match-layer`, aligned with the textarea using measured character width, line height, padding, scroll, and tab size. The current match scrolls into view. Edits recompute matches and try to keep the match whose start index did not move. Highlights follow textarea scroll and window resize.

Server listings and container listings are searched with the same function. The mode (`browser` or `editor`) decides which one runs.

## Feature: context menu, rename, copy, delete

**What it does.** Right-clicking a row selects it and opens Rename, Copy, and Delete. The page context menu is suppressed everywhere except the editor textarea, so the editor keeps the normal text menu.

**Dependency.** Host rename uses SFTP `rename` (`ssh:rename`). Host copy uses `cp -rp` (`ssh:copy`, `ssh:copy-sudo`). Host delete uses `rm -rf` (`ssh:delete`, `ssh:delete-sudo`). Container rename and delete use `docker exec` (`ssh:docker-rename`, `ssh:docker-delete`). Copy is not offered inside a container: the paste buttons are hidden for the whole time Docker mode is on.

**How rename works.** The dialog selects the name without the extension (the whole name for a directory). Empty names and names containing `/` are rejected. The new path is the current directory plus the new name. Failure stays in the dialog. Success reloads the directory.

**How copy works.** Copy stores `{ name, fullPath }` in renderer memory. It is not the operating-system clipboard. Paste runs `cp -rp` from the stored path to the current directory. Pasting into the same directory uses the name `copy of <original>`. If the server returns permission denied, a sudo dialog asks for a password and retries with `sudo -S`. A wrong sudo password is detected from stderr (`incorrect password`, `Sorry`, `try again`) and the dialog stays open. The clipboard survives a hop. It is cleared on server exit and on disconnect.

**How delete works.** A confirm dialog states that the delete cannot be undone. The host command is `rm -rf` over exec, so directories are removed. Permission denied opens the same sudo dialog. Inside a container the command is `docker exec <id> rm -rf <path>`. There is no sudo path for container deletes. `rm -rf` is destructive. Do not widen this to paths the user did not select.

There is no sudo path for rename.

## Feature: upload

**What it does.** Dropping local files on the file area uploads them into the current directory. A panel shows a progress bar per file. Uploads run one after another. The directory reloads when the batch finishes. A fully successful batch hides the panel after three seconds.

**Dependency.** Electron `webUtils.getPathForFile` in the preload, because the renderer cannot read a `File` path under context isolation. Host upload uses SFTP `fastPut` (`ssh:upload`). Progress events are `upload:progress`. Container upload uses that SFTP step onto the SSH host, then `docker cp` (`ssh:docker-upload`). Both need the active SFTP session. Container upload also needs the remote `docker` binary and a selected container.

**How it is implemented.** The drop overlay shows the destination path, or `containerName:path` in Docker mode. For a container, the file is uploaded to `/tmp/.ssh-explorer-<timestamp>-<filename>` on the SSH host, `docker cp` copies it to `<containerId>:<dir>/<filename>`, and the temp file is removed with `rm -f` whether `docker cp` worked or not. Progress events fire during the SFTP step only.

The editor surface calls `preventDefault` on file drags so a drop on the editor does not upload.

## Feature: text editor for host files

**What it does.** Opening a file that is not a known binary type opens a full-window editor: a textarea, a path line, an “Unsaved changes” badge, Save, and Exit. The caret is a normal textarea caret. The user can type, select, and move as in a plain text field. Tab inserts a tab character. Ctrl+S or Cmd+S saves. Escape asks to leave.

**Dependency.** SFTP read (`ssh:readfile`) and SFTP write (`ssh:writefile`). If the SSH account cannot write the file, `ssh:writefile-as` plus a remote `su` and the account-picking rules in `editor-state.js`. No third-party editor component.

**What opens the editor.** `activateFileItem` sends known binary extensions to the read-only preview (`READ_ONLY_EXTENSIONS`: images, audio, video, archives, office documents, executables, and fonts). Every other non-symlink file opens the editor. If the read then reports a binary file, a file over the size limit, or invalid UTF-8, the editor closes and the preview shows that result instead.

**Read rules.** `ssh:readfile` stats the file first. Larger than 1 MB (`MAX_PREVIEW_BYTES`) is refused. A null byte in the first 8 KB is treated as binary. The reply includes `content`, `size`, `mtime`, and `utf8`. The editor refuses to become editable when `mtime` or `size` is missing, because a later save could not detect a remote change.

**Newlines.** `classifyNewlines` records whether the file used LF, CRLF, or CR. The textarea always stores LF (`toEditorText`). Save converts back with `prepareForSave` before the bytes are sent.

**Dirty state.** Dirty means the textarea value differs from `baseline`. Baseline is set when the file loads and again only after the server accepts a write (`applySaveResult`). Save with no difference shows “No changes to save” and leaves the editor open. Exit with no difference closes the editor.

**What Save does today.** A successful write closes the editor and reloads the directory. Ctrl+S uses the same path (`exitAfter: false` still closes on success). `taks.txt` describes a save that would leave the editor open. The code does not do that. Change it only when that behavior is explicitly requested.

**Unsaved-changes dialog.** Exit, and any navigation that would drop the buffer, checks dirty state through `leaveEditorThen`. The dialog title is “You have unsaved changes”. The left button is “Save and exit”. The right button is “exit without saving”. Save and exit writes, then closes. Exit without saving closes and drops the buffer. Disconnect, server exit, hop, entering a container, and leaving a container all go through this check. A save already in progress, or the account-password dialog, blocks those actions.

**Conflict check.** `assessRemoteChange` compares the `mtime` and `size` from open (or from the last successful save) with a fresh stat. Both values must be finite and equal. `force: true` skips the check. A mismatch returns `conflict` and does not write. The dialog “The remote file has changed” offers Cancel and Overwrite. Overwrite retries with `force: true`. The user’s text stays in the editor until a write succeeds. A missing mtime or size is also a conflict, so the file is not overwritten when it cannot be checked.

**In-place SFTP write.** `prepareRemoteWrite` rejects a missing path, non-string content, a null byte in the text, a payload over 1 MB, a lost connection, and anything that is not a regular file. `writeRemoteFile` opens the existing file with `SSH_FXF_WRITE` (`0x02`) and no create flag, writes at offset 0, and `fsetstat`s the size when the new file is shorter. That path matters when the file is writable and the directory is not: create-and-truncate is rejected by the server in that case. If the write-only open fails for a reason other than permission, the code falls back to `writeFile` with flag `w`. Permission denied sets `needsElevation` and does not fall back to truncate.

**Saving as another account.** This is `su`, not `sudo`. The SFTP error tells the editor the SSH account cannot write. `describeElevation` stats uid, gid, and mode, then runs a remote script (`accountFactsCommand`) that prints the current user, `UID_MIN` from `/etc/login.defs`, the owner’s passwd line, and up to 40 group members. `chooseWriteAccount` picks:

- the owner, when the mode has owner-write, the owner is a different user, the shell is a real login shell, and the uid is not a system uid below `UID_MIN`;
- otherwise the first group member that passes the same tests, when the mode has group-write;
- otherwise `root`.

`elevationPrompt` explains that choice and lets the user type a different account name. The name must match `^[A-Za-z_][A-Za-z0-9_.-]{0,31}$`. The password cannot be empty, longer than 1024 characters, or contain a null, CR, or LF.

The save then:

1. Re-checks the conflict rules.
2. Writes the new bytes to `/tmp/.ssh-explorer-save-<time>-<random>` via SFTP, mode `0600`.
3. If the chosen account is not root, `chmod 644` on that temp file so the other account can read it.
4. Runs `su -s /bin/sh <user> -c <script>` on a PTY. If that `su` rejects `-s`, it retries `su <user> -c <script>`.
5. On the first `Password:` prompt, writes the password once. A second prompt is treated as a rejected password and the channel is closed.
6. The script copies the temp file onto the destination with `dd` when `dd` exists, otherwise `cat > dest`. It records the inode before the copy and fails if the inode changed, so the destination is updated in place and is not replaced.
7. A success marker in the output is required. The marker and the password are stripped from any error text shown to the user.
8. The temp file is unlinked in a `finally` block.

The owner and mode of the destination stay as they were, because the inode is not replaced. Container files never use this dialog. The elevated-save callback returns an error if the open target is a container.

**Session guard.** `editingSessionKey` is `username@host:port` for a host file. A save is refused when that key no longer matches the server on screen (`sameEditingSession`). The message is “Saving is unavailable because the connection was lost.”

## Feature: read-only preview

**What it does.** Shows file text in a `<pre>` for types that are not edited, and for editor reads that turn out to be binary, too large, or not UTF-8. JSON is parsed and pretty-printed. Valid JSON is colored (keys, strings, numbers, booleans, null). Invalid JSON is shown as escaped text. There is no save button.

**Dependency.** The same read IPC as the editor (`ssh:readfile` or `ssh:docker-readfile`). Closing uses the preview’s own close button, backdrop click, or Escape when the editor is not open.

## Feature: Docker browser

**What it does.** The toolbar Docker button lists containers on the SSH host. A running container replaces the file view with that container’s filesystem, starting at `/`. The title and status bar name the container. “Exit container” returns to the host path that was open before the container. Stopped containers are listed and cannot be entered. The status line says the container is not running.

**Dependency.** An active SSH session, because every Docker command is `exec` on that host. The remote machine must have a `docker` CLI the SSH user can run. This is not the Docker Engine API and it does not use a local Docker socket. `docker-files.js` is required for reading and saving files. Listing and `ls` live in `main.js`.

**How listing works.** `ssh:docker-containers` runs:

`docker ps -a --format "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}"`

A missing `docker` binary (stderr matching `docker: command not found`, or exit code 127) returns success with an empty list and `unavailable: true`. The menu then shows “No docker containers found or maybe no docker installed”. That string is duplicated on purpose in `docker-files.js` (`DOCKER_MISSING_MSG`) and in `renderer/app.js`. Other failures show the remote error. A container is `running` when its status starts with `Up `.

**How directory listing works.** `ssh:docker-readdir` runs `docker exec <id> /bin/sh -c 'ls -la <path>'`, quoted with `escapeSh`. If that prints nothing it retries `docker exec <id> ls -la <path>`. `parseLsLa` understands the usual `ls -la` columns used by GNU and BusyBox. The name is the remainder of the line after the date field. Symlink lines keep the name before ` -> `. `mtime` is always 0. `.` and `..` are dropped. Sort matches the host browser.

**UI while inside a container.** The Docker button is hidden, Exit container is shown, and paste is hidden. Back, forward, up, refresh, breadcrumb, type-ahead, find, rename, and delete still work and call the `ssh:docker-*` channels. Entering or leaving a container closes a clean editor immediately and asks first when the editor is dirty. A failed hop that was started from inside a container leaves Docker mode and reloads the host path saved in `preDockerPath`.

## Feature: text editor for container files

**What it does.** The same editor UI as host files. The path line is `containerName:absolutePath`. Save and the unsaved-change dialog behave the same, including closing the editor after a successful save.

**Dependency.** `docker-files.js` through `ssh:docker-readfile`, `ssh:docker-stat`, and `ssh:docker-writefile`. The SSH session must still be the one that was active when the file was opened. The remote `docker` CLI must work, and the container must be running. There is no `su` and no `sudo` for container saves. `guardWriteChannel` rejects a container payload on `ssh:writefile` and rejects a host payload on `ssh:docker-writefile`.

**Read rules.** The container id must be 12 to 64 hex characters. The path must be absolute, at most 4096 characters, with no null, CR, LF, empty segment, or `.` / `..` segment. Symlinks are detected with `[ -L ]` and are not followed and not opened. Directories and special files are refused. Files over 1 MB are refused. The metadata script prints type, writable bit, `/proc/mounts` when that file exists, and `stat` size plus mtime. File bytes are `cat` on stdout. Metadata is on stderr so it is not mixed into the file. The read is discarded if the byte length does not equal the stat size. Null bytes and invalid UTF-8 are not edited. `writable` in the reply is true only when the file is writable by the container user and the mount is not read-only.

**Mtime.** GNU `stat` `%s|%Y|%y` supplies epoch seconds plus a human timestamp. A fractional second becomes milliseconds. Without a fraction the value is whole seconds. Conflict checks compare this number and the size exactly. A change that leaves both the same is not detected. Host SFTP mtimes come from the SSH file attributes and are compared the same way, but they are a different clock source. Do not mix a host mtime with a container mtime.

**Write rules.** `saveContainerFile` refuses to start unless all of the following hold:

- The payload is text, has no null byte, and is at most 1 MB.
- `docker inspect` reports the container status `running`.
- The file is a regular file, metadata is readable, the mount is not read-only, and the current container user can write it. The editor does not switch to root.
- `mtime` and `size` still match, unless `force` is set.

The write is not atomic. `cat > file` truncates the destination before the new bytes arrive. The sequence limits the damage:

1. `docker cp` the container file to `/tmp/.ssh-explorer-docker-<time>-<16 hex>` on the SSH host.
2. `chmod 600` that backup. `wc -c` must equal the probed size. Any failure before the write leaves the container file untouched and deletes the backup.
3. `docker exec -i` with `cat > <path>` and the exact UTF-8 buffer on stdin. No PTY, no `-u`, no `chown`.
4. Read the container file back and require the bytes to match.
5. Return the new mtime and size. The editor stores those as the next conflict baseline.
6. Delete the host backup.

If the write or the verify fails and the SSH connection is still up, the backup is streamed back with the same `cat >` command. The code does not `docker cp` the backup into the container, because that would replace the inode and can change the owner to root. After a restore it reads the file again and compares it to the backup. The user sees whether the previous version was restored or whether the container file may be incomplete. Their text stays in the editor.

If the connection drops before the write starts, nothing was changed. If it drops after the write starts, the result is `uncertain`: the container file may be incomplete or unchanged, and the editor keeps the text.

A verified write whose new mtime cannot be read is reported as a failure even though the bytes were checked, and the message tells the user to reopen the file before saving again. That avoids a later save with no conflict baseline.

**Session guard.** The editor session key is `username@host:port|docker:<containerId>`. Saving after the user has switched containers, or after the SSH server changed, is refused. The container-specific message is “This container is no longer the one being browsed, so the file was not saved.”

## Feature: window chrome

**What it does.** Minimize, maximize/unmaximize, and close, because the window has no OS frame. The title bar shows `SSH Explorer` or `SSH Explorer — <connection>`.

**Dependency.** Electron `BrowserWindow` only. IPC: `window:minimize`, `window:maximize`, `window:close`, `window:is-maximized`. Close runs `sshNav.cleanup()` and then closes the window.

## Secrets

Passwords, key passphrases, sudo passwords, and `su` passwords exist only for the attempt that needs them.

- Connect, bastion, and hop passwords are arguments to `ssh:connect` and `ssh:hop`. They are not in `ssh-form-memory.json`.
- A key passphrase is returned on `ssh:passphrase-reply` and is passed to `utils.parseKey`. It is not written to disk.
- A sudo password is an argument to `ssh:copy-sudo` or `ssh:delete-sudo` and is written to `sudo -S` stdin for that command.
- An account password for `su` is an argument to `ssh:writefile-as`. It is written once to the PTY. `redactSecret` removes it from any error string. The temp file that holds the new file contents is unlinked after the attempt.

Do not add these values to form memory, logs, or the window title.

## Limits that later changes should keep

- Host file reads and writes, and container file reads and writes, stop at 1 MB.
- Binary files (a null byte) are not written back.
- Symlinks inside a container are not opened and not overwritten.
- Container paths stay absolute and cannot contain `.` or `..`.
- Container saves do not use the SFTP writer. Host saves do not use the Docker writer.
- A save does not overwrite a remote file whose mtime or size changed, unless the user chooses Overwrite.
- Elevated host saves use `su` and an in-place copy that preserves the inode. They do not use `sudo`, and they do not delete the destination.
- Container saves do not change user to root and do not `docker cp` onto the destination.
- The bastion is not a step in the Exit stack.
- Hopping does not close the parent SSH client or the bastion.
- A new connect from the first screen drops the previous stack.
- Form memory never stores a password.

## What the app does not do

These are absent on purpose in the current code. Do not describe them as features.

- No local disk browser and no download-to-desktop.
- No create-file, create-folder, chmod, or chown UI.
- No interactive shell.
- No multi-select.
- No copy or paste inside a container.
- No “commonly used” folder suggestions. That item is only a note in `taks.txt`.
- Find is implemented. The Ctrl+F line in `taks.txt` is stale.
- Save currently closes the editor. The “keep the file open after save” line in `taks.txt` is not what the code does.

## Tests

`npm test` runs the Node test runner.

| File | What it locks down |
| --- | --- |
| `test/ssh-nav.test.js` | Stack behavior with fake clients and with real `ssh2` servers: exit, multi-hop, bastion lifetime, failed hop, disconnect, and a new direct connect. |
| `test/ssh-keys.test.js` | Config matching, identity order, loose permissions, agent-then-password, passphrase timing. Also checks that form memory can remember `useKey` and still drop a password. |
| `test/docker-files.test.js` | Quoting, path and id checks, symlink and read-only refusal, conflict detection, exact-byte writes, backup restore, and a dropped connection. |
| `test/search.test.js` | Shortcut platform rules, folder filter, editor matches, and highlight geometry. |

When a change touches navigation, key selection, container file IO, or find behavior, run `npm test` before calling the work done. The UI itself is an Electron renderer. The node tests do not open the window.
