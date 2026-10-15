// Find-bar decisions shared by the file browser and the text editor.
// No DOM, SSH, or Docker command execution lives here.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.appSearch = api;
})(function () {
  const NO_MATCHES = 'No matches';
  const NO_DIRECTORY_MATCHES = 'No matching files or folders';

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isMacPlatform(platform) {
    return /mac|darwin|iphone|ipad/i.test(String(platform || ''));
  }

  function isFindShortcut(event, platform) {
    if (!event || event.altKey || event.shiftKey || event.isComposing) return false;
    if (String(event.key || '').toLowerCase() !== 'f') return false;
    const mac = isMacPlatform(platform);
    if (mac) return !!event.metaKey && !event.ctrlKey;
    return !!event.ctrlKey && !event.metaKey;
  }

  // Enter and Shift+Enter move matches only while the search field itself is focused,
  // so a newline in the editor and Enter on a file row keep their existing behavior.
  function findBarKeyAction(event, state) {
    const info = state || {};
    if (isFindShortcut(event, info.platform)) return info.open ? 'refocus' : 'open';
    if (!info.open || !event || event.isComposing) return null;
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    if (event.key === 'Escape' && !event.shiftKey) return 'close';
    if (event.key === 'Enter' && info.inputFocused) return event.shiftKey ? 'prev' : 'next';
    return null;
  }

  function createFindState() {
    return { open: false, query: '', mode: 'browser', matchIndex: -1 };
  }

  function openFind(state, mode) {
    const current = state || createFindState();
    const query = String(current.query || '');
    return {
      open: true,
      query,
      mode: mode === 'editor' ? 'editor' : 'browser',
      matchIndex: query ? 0 : -1,
    };
  }

  function closeFind(state) {
    const current = state || createFindState();
    return {
      open: false,
      query: String(current.query || ''),
      mode: current.mode === 'editor' ? 'editor' : 'browser',
      matchIndex: -1,
    };
  }

  function setFindQuery(state, query) {
    const current = state || createFindState();
    const text = String(query == null ? '' : query);
    return {
      open: !!current.open,
      query: text,
      mode: current.mode === 'editor' ? 'editor' : 'browser',
      matchIndex: text ? 0 : -1,
    };
  }

  function browserIsFiltered(state) {
    return !!(state && state.open && state.mode === 'browser' && state.query);
  }

  function filterDirectoryEntries(files, query) {
    const list = Array.isArray(files) ? files : [];
    const needle = String(query == null ? '' : query);
    if (!needle) return list.slice();
    const re = new RegExp(escapeRegExp(needle), 'i');
    return list.filter((file) => file && re.test(String(file.name == null ? '' : file.name)));
  }

  // Closed search never filters. Editor search never uses directory entries.
  function directoryResults(state, files) {
    const list = Array.isArray(files) ? files.slice() : [];
    if (!state || !state.open || state.mode !== 'browser') return list;
    return filterDirectoryEntries(list, state.query);
  }

  function splitHighlight(name, query) {
    const text = String(name == null ? '' : name);
    const needle = String(query == null ? '' : query);
    if (!needle || !text) return [{ text, match: false }];
    const re = new RegExp(escapeRegExp(needle), 'gi');
    const parts = [];
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!match[0]) {
        re.lastIndex += 1;
        continue;
      }
      if (match.index > last) parts.push({ text: text.slice(last, match.index), match: false });
      parts.push({ text: match[0], match: true });
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), match: false });
    if (!parts.length) parts.push({ text, match: false });
    return parts;
  }

  function findTextMatches(text, query) {
    const source = String(text == null ? '' : text);
    const needle = String(query == null ? '' : query);
    if (!needle) return [];
    const re = new RegExp(escapeRegExp(needle), 'gi');
    const matches = [];
    let match;
    while ((match = re.exec(source)) !== null) {
      if (!match[0]) {
        re.lastIndex += 1;
        continue;
      }
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
    return matches;
  }

  function editorResults(state, buffer) {
    if (!state || !state.open || state.mode !== 'editor') return [];
    return findTextMatches(buffer, state.query);
  }

  function clampMatchIndex(index, count) {
    if (!count) return -1;
    if (!Number.isInteger(index) || index < 0) return 0;
    if (index >= count) return count - 1;
    return index;
  }

  function stepMatchIndex(index, count, direction) {
    if (!count) return -1;
    const dir = direction < 0 ? -1 : 1;
    if (!Number.isInteger(index) || index < 0) return dir < 0 ? count - 1 : 0;
    return (index + dir + count) % count;
  }

  function formatMatchStatus(index, count, query) {
    if (!query) return '';
    if (!count) return NO_MATCHES;
    const shown = clampMatchIndex(index, count) + 1;
    return `${shown} of ${count}`;
  }

  // Keep the same match across edits when its start is unchanged.
  function syncTextMatches(text, query, previous) {
    const matches = findTextMatches(text, query);
    if (!matches.length) return { matches, index: -1 };
    const prev = previous && Array.isArray(previous.matches) && previous.index >= 0
      ? previous.matches[previous.index]
      : null;
    if (!prev) return { matches, index: 0 };
    const exact = matches.findIndex((item) => item.start === prev.start && item.end === prev.end);
    if (exact >= 0) return { matches, index: exact };
    const atOrAfter = matches.findIndex((item) => item.start >= prev.start);
    return { matches, index: atOrAfter >= 0 ? atOrAfter : matches.length - 1 };
  }

  function lineStarts(text) {
    const source = String(text || '');
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
  }

  function lineIndexAt(starts, index) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function visualColumn(text, lineStart, index, tabSize) {
    const tab = tabSize > 0 ? tabSize : 2;
    let column = 0;
    const end = Math.max(lineStart, index);
    for (let i = lineStart; i < end; i++) {
      if (text.charCodeAt(i) === 9) column += tab - (column % tab);
      else column += 1;
    }
    return column;
  }

  function matchVisualPosition(text, index, tabSize) {
    const source = String(text || '');
    const at = Math.max(0, Math.min(Number(index) || 0, source.length));
    const starts = lineStarts(source);
    const line = lineIndexAt(starts, at);
    return {
      line,
      column: visualColumn(source, starts[line], at, tabSize),
    };
  }

  function layoutMatchHighlights(text, matches, currentIndex, view) {
    const source = String(text || '');
    const list = Array.isArray(matches) ? matches : [];
    const metrics = view || {};
    const lineHeight = metrics.lineHeight > 0 ? metrics.lineHeight : 20;
    const charWidth = metrics.charWidth > 0 ? metrics.charWidth : 8;
    const paddingTop = Number(metrics.paddingTop) || 0;
    const paddingLeft = Number(metrics.paddingLeft) || 0;
    const scrollTop = Number(metrics.scrollTop) || 0;
    const scrollLeft = Number(metrics.scrollLeft) || 0;
    const clientHeight = metrics.clientHeight > 0 ? metrics.clientHeight : 0;
    const tabSize = metrics.tabSize > 0 ? metrics.tabSize : 2;
    const starts = lineStarts(source);
    const firstLine = Math.max(0, Math.floor((scrollTop - paddingTop) / lineHeight) - 1);
    const visibleLines = clientHeight > 0 ? Math.ceil(clientHeight / lineHeight) + 3 : starts.length + 1;
    const lastLine = firstLine + visibleLines;
    const boxes = [];
    for (let i = 0; i < list.length; i++) {
      const match = list[i];
      if (!match || match.end <= match.start) continue;
      const line = lineIndexAt(starts, match.start);
      const current = i === currentIndex;
      if (!current && (line < firstLine || line > lastLine)) continue;
      const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : source.length;
      const column = visualColumn(source, starts[line], match.start, tabSize);
      const endCol = visualColumn(source, starts[line], Math.min(match.end, lineEnd), tabSize);
      boxes.push({
        top: paddingTop + line * lineHeight - scrollTop,
        left: paddingLeft + column * charWidth - scrollLeft,
        width: Math.max(charWidth, (endCol - column) * charWidth),
        height: lineHeight,
        current,
        index: i,
      });
    }
    return boxes;
  }

  function scrollOffsetForMatch(line, scrollTop, clientHeight, paddingTop, lineHeight) {
    const top = (Number(paddingTop) || 0) + line * lineHeight;
    const bottom = top + lineHeight;
    const current = Number(scrollTop) || 0;
    const height = clientHeight > 0 ? clientHeight : 0;
    if (top >= current && bottom <= current + height) return current;
    const margin = Math.min(lineHeight * 2, height / 3);
    return Math.max(0, top - margin);
  }

  function scrollOffsetForColumn(column, scrollLeft, clientWidth, paddingLeft, charWidth) {
    const left = (Number(paddingLeft) || 0) + column * charWidth;
    const right = left + Math.max(charWidth, 1);
    const current = Number(scrollLeft) || 0;
    const width = clientWidth > 0 ? clientWidth : 0;
    if (left >= current && right <= current + width - 24) return current;
    return Math.max(0, left - 40);
  }

  return {
    NO_MATCHES,
    NO_DIRECTORY_MATCHES,
    isMacPlatform,
    isFindShortcut,
    findBarKeyAction,
    createFindState,
    openFind,
    closeFind,
    setFindQuery,
    browserIsFiltered,
    filterDirectoryEntries,
    directoryResults,
    splitHighlight,
    findTextMatches,
    editorResults,
    clampMatchIndex,
    stepMatchIndex,
    formatMatchStatus,
    syncTextMatches,
    matchVisualPosition,
    layoutMatchHighlights,
    scrollOffsetForMatch,
    scrollOffsetForColumn,
  };
});
