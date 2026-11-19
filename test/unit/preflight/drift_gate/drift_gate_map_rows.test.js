'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const { parseMapRows } = require('../../../../bin/preflight_map_rows.js');
const { compareRows } = require('../../../../bin/preflight_handler_dirs.js');

const REAL_MAP = path.join(__dirname, '..', '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md');
const HASH = 'b38ea784128e91c87c0df0200696d2b0bac25105477c9111d929a420f30e6afc';

// The handler set the pre-flight checks are pinned against; a dropped or renamed row
// changes this list and fails here, not silently in the gate.
const EXPECTED_HANDLERS = [
    'src/actions/airdrop/', 'src/actions/batch/', 'src/actions/bet/', 'src/actions/deposit.js',
    'src/actions/destroy/', 'src/actions/dispense/', 'src/actions/dispenser/', 'src/actions/dividend/',
    'src/actions/issue/', 'src/actions/mint/', 'src/actions/order/', 'src/actions/price/',
    'src/actions/send/', 'src/actions/stake/', 'src/actions/swap/', 'src/actions/withdraw.js',
];

const mapText = () => fs.readFileSync(REAL_MAP, 'utf8');
const rowLine = (handler, hash) => `| \`checks/x.js\` | ${handler} | ${hash} |`;
const parsed = (line) => parseMapRows(`header\n${line}\ntrailer\n`);

describe('pre-flight map row parser', function () {
    it('the real map parses to exactly the expected handler set, every row well formed', function () {
        const rows = parseMapRows(mapText());
        expect(rows.map((r) => r.handler).sort()).to.deep.equal(EXPECTED_HANDLERS);
        expect(rows.filter((r) => r.kind === 'malformed')).to.deep.equal([]);
    });

    it('a mistyped hash or path on a pin row comes back malformed instead of vanishing', function () {
        const cases = {
            'a 63-digit hash': rowLine('`src/actions/stake/`', `\`${HASH.slice(1)}\``),
            'an abbreviated hash': rowLine('`src/actions/stake/`', '`b38ea784`'),
            'an upper-case hash': rowLine('`src/actions/stake/`', `\`${HASH.toUpperCase()}\``),
            'a hash that lost its backticks': rowLine('`src/actions/stake/`', HASH),
            'a handler that lost its backticks': rowLine('src/actions/stake/', `\`${HASH}\``),
            'a handler with the wrong prefix': rowLine('`actions/stake/`', `\`${HASH}\``),
            'a hash with one non-hex character': rowLine('`src/actions/stake/`', `\`${HASH.slice(0, 63)}g\``),
            'a handler path with a typo': rowLine('`src/actoins/stake/`', `\`${HASH}\``),
        };
        for (const [label, line] of Object.entries(cases)) {
            const rows = parsed(line);
            expect(rows, label).to.have.lengthOf(1);
            expect(rows[0].kind, label).to.equal('malformed');
        }
    });

    it('a mistyped STAKE or BET row fails the comparison through the missing list', function () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-map-rows-'));
        try {
            for (const name of ['stake', 'bet']) {
                const pinned = parseMapRows(mapText()).find((r) => r.handler === `src/actions/${name}/`).hash;
                const text = mapText().replace(pinned, pinned.slice(1));
                const rows = parseMapRows(text);
                expect(rows.filter((r) => r.kind === 'malformed'), name).to.have.lengthOf(1);
                const { missing } = compareRows(root, rows);
                expect(missing.some((m) => m.includes(`src/actions/${name}/`) && m.includes('pin pattern')), name).to.equal(true);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('control: a placeholder pin and an unrelated hash table are not pin rows', function () {
        expect(parsed(rowLine('`src/actions/batch/`', '`<64-hex digest>`'))).to.deep.equal([]);
        expect(parsed('| `312a1fef` | a commit that names no handler |')).to.deep.equal([]);
        expect(parsed('Prose naming `src/actions/send/` and `b38ea784` outside any table.')).to.deep.equal([]);
    });

    it('control: well formed rows keep document order and are not reported twice', function () {
        const text = [rowLine('`src/actions/mint/`', `\`${HASH}\``), rowLine('`src/actions/send/`', '`b38ea784`'),
            rowLine('`src/actions/issue/`', `\`${HASH}\``)].join('\n');
        expect(parseMapRows(text).map((r) => [r.handler, r.kind])).to.deep.equal([
            ['src/actions/mint/', 'directory'], ['src/actions/send/', 'malformed'], ['src/actions/issue/', 'directory']]);
    });
});
