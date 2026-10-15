'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../renderer/search');

const sampleDir = [
  { name: 'config.json', isDirectory: false },
  { name: 'config-backup.json', isDirectory: false },
  { name: 'logs', isDirectory: true },
  { name: 'settings', isDirectory: true },
];

test('Ctrl+F opens search on Windows and Linux, Cmd+F on macOS', () => {
  assert.equal(search.isFindShortcut({ key: 'f', ctrlKey: true }, 'Win32'), true);
  assert.equal(search.isFindShortcut({ key: 'F', ctrlKey: true }, 'Linux x86_64'), true);
  assert.equal(search.isFindShortcut({ key: 'f', metaKey: true }, 'MacIntel'), true);
  assert.equal(search.isFindShortcut({ key: 'f', metaKey: true }, 'darwin'), true);
  assert.equal(search.isFindShortcut({ key: 'f', ctrlKey: true }, 'MacIntel'), false);
  assert.equal(search.isFindShortcut({ key: 'f', metaKey: true }, 'Win32'), false);
  assert.equal(search.isFindShortcut({ key: 'f', ctrlKey: true, shiftKey: true }, 'Win32'), false);
  assert.equal(search.findBarKeyAction(
    { key: 'f', ctrlKey: true },
    { open: false, platform: 'Win32' }
  ), 'open');
  assert.equal(search.findBarKeyAction(
    { key: 'f', metaKey: true, ctrlKey: false },
    { open: false, platform: 'MacIntel' }
  ), 'open');
  assert.equal(search.findBarKeyAction(
    { key: 'f', ctrlKey: true },
    { open: true, platform: 'Win32' }
  ), 'refocus');
});

test('Ctrl/Cmd+S is not treated as find', () => {
  assert.equal(search.findBarKeyAction(
    { key: 's', ctrlKey: true },
    { open: true, inputFocused: true, platform: 'Win32' }
  ), null);
  assert.equal(search.findBarKeyAction(
    { key: 's', metaKey: true, ctrlKey: false },
    { open: true, inputFocused: true, platform: 'MacIntel' }
  ), null);
  assert.equal(search.isFindShortcut({ key: 's', ctrlKey: true }, 'Win32'), false);
});

test('Enter, Shift+Enter, and Escape apply only to an open search field', () => {
  const open = { open: true, inputFocused: true, platform: 'Win32' };
  assert.equal(search.findBarKeyAction({ key: 'Enter' }, open), 'next');
  assert.equal(search.findBarKeyAction({ key: 'Enter', shiftKey: true }, open), 'prev');
  assert.equal(search.findBarKeyAction({ key: 'Escape' }, { open: true, inputFocused: false, platform: 'Win32' }), 'close');
  assert.equal(search.findBarKeyAction({ key: 'Enter' }, { open: true, inputFocused: false, platform: 'Win32' }), null);
  assert.equal(search.findBarKeyAction({ key: 'Escape' }, { open: false, platform: 'Win32' }), null);
});

test('directory search is partial, case-insensitive, and keeps sort order', () => {
  assert.deepEqual(
    search.filterDirectoryEntries(sampleDir, 'config').map((file) => file.name),
    ['config.json', 'config-backup.json']
  );
  assert.deepEqual(
    search.filterDirectoryEntries(sampleDir, 'LOG').map((file) => ({
      name: file.name,
      isDirectory: file.isDirectory,
    })),
    [{ name: 'logs', isDirectory: true }]
  );
  assert.deepEqual(
    search.filterDirectoryEntries(sampleDir, 'JSON').map((file) => file.isDirectory),
    [false, false]
  );
  const ordered = [
    { name: 'b-config', isDirectory: true },
    { name: 'a-config', isDirectory: false },
  ];
  assert.deepEqual(
    search.filterDirectoryEntries(ordered, 'config').map((file) => file.name),
    ['b-config', 'a-config']
  );
  assert.equal(search.filterDirectoryEntries(sampleDir, 'missing').length, 0);
  assert.equal(
    search.filterDirectoryEntries(
      [{ name: 'config.json' }, { name: 'configXjson' }],
      'config.json'
    ).length,
    1
  );
});

test('filename highlights mark each partial match', () => {
  assert.deepEqual(search.splitHighlight('config.json', 'config'), [
    { text: 'config', match: true },
    { text: '.json', match: false },
  ]);
  assert.deepEqual(search.splitHighlight('Config', 'c'), [
    { text: 'C', match: true },
    { text: 'onfig', match: false },
  ]);
});

test('closing search keeps the query but stops filtering', () => {
  let state = search.setFindQuery(search.openFind(search.createFindState(), 'browser'), 'config');
  assert.deepEqual(
    search.directoryResults(state, sampleDir).map((file) => file.name),
    ['config.json', 'config-backup.json']
  );
  state = search.closeFind(state);
  assert.equal(state.open, false);
  assert.equal(state.query, 'config');
  assert.equal(search.browserIsFiltered(state), false);
  assert.deepEqual(
    search.directoryResults(state, sampleDir).map((file) => file.name),
    sampleDir.map((file) => file.name)
  );
  state = search.openFind(state, 'browser');
  assert.equal(state.query, 'config');
  assert.equal(search.browserIsFiltered(state), true);
});

test('clearing the query makes the next search start empty', () => {
  let state = search.setFindQuery(search.openFind(search.createFindState(), 'browser'), 'logs');
  state = search.setFindQuery(state, '');
  state = search.closeFind(state);
  state = search.openFind(state, 'browser');
  assert.equal(state.query, '');
  assert.equal(search.directoryResults(state, sampleDir).length, sampleDir.length);
  assert.equal(search.formatMatchStatus(state.matchIndex, 4, state.query), '');
});

test('the same query is restored for editor search after navigation', () => {
  let state = search.setFindQuery(search.openFind(search.createFindState(), 'browser'), 'logs');
  state = search.closeFind(state);
  state = search.openFind(state, 'editor');
  assert.equal(state.query, 'logs');
  assert.equal(state.mode, 'editor');
  assert.deepEqual(
    search.directoryResults(state, sampleDir).map((file) => file.name),
    sampleDir.map((file) => file.name)
  );
  state = search.closeFind(state);
  state = search.openFind(state, 'browser');
  assert.equal(state.query, 'logs');
  assert.equal(state.mode, 'browser');
});

test('server and docker listings are searched independently', () => {
  const server = [
    { name: 'config.json', isDirectory: false },
    { name: 'notes.txt', isDirectory: false },
  ];
  const docker = [
    { name: 'config.yml', isDirectory: false },
    { name: 'logs', isDirectory: true },
  ];
  const browsing = search.setFindQuery(search.openFind(search.createFindState(), 'browser'), 'config');
  assert.deepEqual(search.directoryResults(browsing, server).map((file) => file.name), ['config.json']);
  assert.deepEqual(search.directoryResults(browsing, docker).map((file) => file.name), ['config.yml']);
  assert.equal(search.directoryResults(browsing, docker)[0].isDirectory, false);
  const editing = search.openFind(search.closeFind(browsing), 'editor');
  assert.deepEqual(search.editorResults(browsing, 'config value'), []);
  assert.equal(search.editorResults(editing, 'config value\nConfig').length, 2);
  assert.deepEqual(search.directoryResults(editing, docker).map((file) => file.name), ['config.yml', 'logs']);
});

test('editor search uses the live buffer, including unsaved text', () => {
  const baseline = 'alpha';
  const current = 'alpha\nalpha beta';
  assert.equal(search.findTextMatches(baseline, 'beta').length, 0);
  const matches = search.findTextMatches(current, 'beta');
  assert.equal(matches.length, 1);
  assert.equal(current.slice(matches[0].start, matches[0].end), 'beta');
  assert.equal(search.findTextMatches('Alpha ALPHA', 'alpha').length, 2);
  assert.equal(search.formatMatchStatus(1, 5, 'alpha'), '2 of 5');
  assert.equal(search.formatMatchStatus(-1, 0, 'alpha'), 'No matches');
});

test('Enter and Shift+Enter walk matches in both directions', () => {
  const matches = search.findTextMatches('aa aa aa', 'aa');
  assert.equal(matches.length, 3);
  let index = 0;
  index = search.stepMatchIndex(index, matches.length, 1);
  assert.equal(index, 1);
  index = search.stepMatchIndex(index, matches.length, 1);
  assert.equal(index, 2);
  index = search.stepMatchIndex(index, matches.length, 1);
  assert.equal(index, 0);
  index = search.stepMatchIndex(index, matches.length, -1);
  assert.equal(index, 2);
  assert.equal(search.formatMatchStatus(index, matches.length, 'aa'), '3 of 3');
});

test('match counts follow query and buffer edits', () => {
  const original = 'red red red';
  const matches = search.findTextMatches(original, 'red');
  assert.equal(matches.length, 3);
  const extended = search.syncTextMatches('red red red red', 'red', { matches, index: 1 });
  assert.equal(extended.matches.length, 4);
  assert.equal(extended.index, 1);
  assert.equal(extended.matches[1].start, matches[1].start);
  const removed = search.syncTextMatches('xxx blue red', 'red', { matches, index: 0 });
  assert.equal(removed.matches.length, 1);
  assert.equal(removed.index, 0);
  const none = search.syncTextMatches('red red', 'blue', { matches, index: 0 });
  assert.deepEqual(none, { matches: [], index: -1 });
  assert.equal(search.formatMatchStatus(none.index, none.matches.length, 'blue'), 'No matches');
});

test('editor highlights are positioned and the current match can scroll into view', () => {
  const text = 'alpha\nbeta alpha\n';
  const matches = search.findTextMatches(text, 'alpha');
  const view = {
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight: 200,
    clientWidth: 400,
    paddingTop: 16,
    paddingLeft: 18,
    lineHeight: 20,
    charWidth: 8,
    tabSize: 2,
  };
  const boxes = search.layoutMatchHighlights(text, matches, 1, view);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].current, false);
  assert.equal(boxes[0].top, 16);
  assert.equal(boxes[0].left, 18);
  assert.equal(boxes[1].current, true);
  assert.equal(boxes[1].top, 36);
  assert.equal(boxes[1].left, 18 + 5 * 8);
  const tabbed = search.findTextMatches('\talpha', 'alpha');
  assert.deepEqual(search.matchVisualPosition('\talpha', tabbed[0].start, 2), { line: 0, column: 2 });
  assert.equal(search.scrollOffsetForMatch(0, 0, 100, 16, 20), 0);
  assert.equal(search.scrollOffsetForMatch(10, 0, 90, 0, 20), 170);
});
