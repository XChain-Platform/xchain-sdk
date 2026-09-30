'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseMapRows, compareRows } = require('../../../bin/preflight_handler_dirs.js');

const DEPOSIT_BYTES = "module.exports = 'deposit';\n";
const WITHDRAW_BYTES = "module.exports = 'withdraw';\n";
const DEPOSIT_HASH = 'a0b6e81071f6936b049954ef7ad90039a170570ee623fa3cb7981015aa373dd6';
const WITHDRAW_HASH = '7d7f8b58b3ff47018d8ce91f3d31e92a20cba4776a7e7e65537387bba8c34eab';
const MAP_FRAGMENT = [
    '| `checks/misc.js` (DEPOSIT) | `src/actions/deposit.js` | `a0b6e81071f6936b049954ef7ad90039a170570ee623fa3cb7981015aa373dd6` |',
    '| `checks/misc.js` (WITHDRAW) | `src/actions/withdraw.js` | `7d7f8b58b3ff47018d8ce91f3d31e92a20cba4776a7e7e65537387bba8c34eab` |',
].join('\n');

function put(root, relativePath, bytes) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, bytes);
}

function putFlatHandlers(root) {
    put(root, 'src/actions/deposit.js', DEPOSIT_BYTES);
    put(root, 'src/actions/withdraw.js', WITHDRAW_BYTES);
}

describe('custody handler map rows', function () {
    let root;

    beforeEach(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-map-rows-'));
    });

    afterEach(function () {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('parses the two annotated rows as flat handler files', function () {
        expect(parseMapRows(MAP_FRAGMENT)).to.deep.equal([
            { handler: 'src/actions/deposit.js', hash: DEPOSIT_HASH, kind: 'file' },
            { handler: 'src/actions/withdraw.js', hash: WITHDRAW_HASH, kind: 'file' },
        ]);
    });

    it('accepts pins matching the bytes of both flat handlers', function () {
        putFlatHandlers(root);
        expect(compareRows(root, parseMapRows(MAP_FRAGMENT))).to.deep.equal({ missing: [], drift: [] });
    });

    it('reports only deposit when one byte of its flat handler changes', function () {
        putFlatHandlers(root);
        const edited = Buffer.from(DEPOSIT_BYTES);
        edited[0] ^= 1;
        put(root, 'src/actions/deposit.js', edited);

        const result = compareRows(root, parseMapRows(MAP_FRAGMENT));
        expect(result.missing).to.deep.equal([]);
        expect(result.drift).to.have.lengthOf(1);
        expect(result.drift[0].handler).to.equal('src/actions/deposit.js');
    });

    it('moves the deposit digest when a companion part is added', function () {
        putFlatHandlers(root);
        put(root, 'src/actions/deposit/validate.js', 'module.exports = () => true;\n');

        const [depositRow] = parseMapRows(MAP_FRAGMENT);
        const result = compareRows(root, [depositRow]);
        expect(result.missing).to.deep.equal([]);
        expect(result.drift).to.have.lengthOf(1);
        expect(result.drift[0].handler).to.equal('src/actions/deposit.js');
        expect(result.drift[0].actual).to.not.equal(DEPOSIT_HASH);
    });

    it('keeps the exact custody labels in the first table cell', function () {
        const firstCells = MAP_FRAGMENT.split('\n').map((line) => line.split('|')[1].trim());
        expect(firstCells).to.deep.equal([
            '`checks/misc.js` (DEPOSIT)',
            '`checks/misc.js` (WITHDRAW)',
        ]);
    });
});
