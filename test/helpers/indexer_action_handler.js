'use strict';

const fs = require('fs');
const path = require('path');

const { resolveIndexerRoot } = require('../../bin/preflight_indexer_root.js');
const { listParts, parseMapRows } = require('../../bin/preflight_handler_dirs.js');

const MAP_PATH = path.join(__dirname, '..', '..', 'src', 'preflight', 'INDEXER-MAP.md');

function actionName(handler) {
    const trimmed = handler.replace(/\/$/, '');
    return path.basename(trimmed, path.extname(trimmed)).toLowerCase();
}

function mappedActionRow(action) {
    const wanted = String(action).toLowerCase();
    const rows = parseMapRows(fs.readFileSync(MAP_PATH, 'utf8'))
        .filter((row) => actionName(row.handler) === wanted);
    if (rows.length !== 1)
        throw new Error(`expected one mapped indexer handler for ${action}, found ${rows.length}`);
    return rows[0];
}

function resolveIndexerAction(action) {
    const root = resolveIndexerRoot();
    if (!root) return null;

    const row = mappedActionRow(action);
    const mappedPath = path.join(root, row.handler);
    const entry = row.kind === 'directory' ? path.join(mappedPath, 'index.js') : mappedPath;
    if (!fs.existsSync(entry))
        throw new Error(`mapped indexer handler entry is missing for ${action}: ${entry}`);

    const sources = row.kind === 'directory'
        ? listParts(mappedPath).filter((name) => /\.(?:c|m)?js$/.test(name))
            .map((name) => path.join(mappedPath, name))
        : [mappedPath];
    return { root, entry, sources };
}

function loadIndexerAction(action) {
    const resolved = resolveIndexerAction(action);
    if (!resolved) return null;
    return { ...resolved, Handler: require(resolved.entry) };
}

module.exports = { mappedActionRow, resolveIndexerAction, loadIndexerAction };
