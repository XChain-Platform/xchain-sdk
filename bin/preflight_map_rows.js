/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Row parser for the pre-flight handler map (src/preflight/INDEXER-MAP.md).
 *
 * A pin row reads | check module | `src/actions/<name>.js` or `src/actions/<name>/` | `<64 hex>` |.
 * A row the strict pattern does not match is returned as 'malformed' instead of being
 * dropped, because a row the parser skips silently is a handler nobody checks while the
 * table still reads complete.
 *
 ********************************************************************/

'use strict';

const ROW_RE = /\|\s*`(src\/actions\/[^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|/g;

// A flat row names a file directly under src/actions/. A path deeper than that is refused
// rather than hashed: pinning src/actions/<name>/index.js alone is exactly the row that
// lets the parts beside it escape, so it must be written as the directory row instead.
const FILE_ROW = /^src\/actions\/[\w-]+\.js$/;
const DIRECTORY_ROW = /^src\/actions\/[\w-]+\/$/;

// A table line that was meant to be a pin row but misses the strict pattern. Two shapes
// qualify. A hash-like cell (a backticked run of seven or more hex digits, a long
// backticked token that is hex but for a typo, or a long bare hex run) on a line that
// names an actions path: abbreviated, short, upper-case, mistyped or unquoted hashes and a
// handler path with the wrong prefix all land here. Or a full-length 64-digit hex cell on
// any table line, which is a pin whatever its path cell says. Requiring the actions path
// for the first shape keeps unrelated tables that carry a short commit id out of it.
const HASH_CELL = /^(?:`[0-9a-fA-F]{7,}`|`[0-9a-zA-Z]{40,}`|[0-9a-fA-F]{32,})$/;
const FULL_PIN_CELL = /^`?[0-9a-fA-F]{64}`?$/;
const ACTIONS_PATH = /\bactions?\//;

const LOOKALIKE_REASON = 'the row does not match the pin pattern; write the handler as `src/actions/<name>.js` '
    + 'or `src/actions/<name>/` and the pin as a lowercase 64-digit hex SHA-256, each in backticks';

function lookalikeRow(line) {
    if (!/^\s*\|/.test(line)) return null;
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    const hash = cells.find((c) => FULL_PIN_CELL.test(c))
        || (ACTIONS_PATH.test(line) ? cells.find((c) => HASH_CELL.test(c)) : undefined);
    if (hash === undefined) return null;
    const cell = cells.find((c) => ACTIONS_PATH.test(c)) || cells.find((c) => c.includes('/')) || line.trim();
    return { handler: cell.replace(/`/g, ''), hash: hash.replace(/`/g, ''), kind: 'malformed', reason: LOOKALIKE_REASON };
}

// Parse the map's table rows in document order, each tagged with the kind of handler it
// names: 'file', 'directory' or 'malformed'.
function parseMapRows(text) {
    const found = [];
    const spans = [];
    let m;
    ROW_RE.lastIndex = 0;
    while ((m = ROW_RE.exec(text)) !== null) {
        const handler = m[1];
        const kind = FILE_ROW.test(handler) ? 'file' : DIRECTORY_ROW.test(handler) ? 'directory' : 'malformed';
        found.push({ at: m.index, row: { handler, hash: m[2], kind } });
        spans.push([m.index, m.index + m[0].length]);
    }
    let at = 0;
    for (const line of text.split('\n')) {
        const end = at + line.length;
        if (!spans.some(([from, to]) => from < end && to > at)) {
            const row = lookalikeRow(line);
            if (row) found.push({ at, row });
        }
        at = end + 1;
    }
    return found.sort((a, b) => a.at - b.at).map((f) => f.row);
}

module.exports = { parseMapRows, ROW_RE, FILE_ROW, DIRECTORY_ROW };
