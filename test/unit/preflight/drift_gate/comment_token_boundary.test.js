'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dirs = require('../../../../bin/preflight_handler_dirs.js');

function put(root, rel, text) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}

function directoryPin(root) {
    const row = dirs.parseMapRows('| `checks/x.js` | `src/actions/fixture/` | `' + '0'.repeat(64) + '` |')[0];
    return dirs.hashMappedRow(root, row).actual;
}

describe('comment-insensitive digest token boundaries', function () {
    it('distinguishes comments that otherwise join executable tokens', function () {
        const separated = "function accepts(value) { return typeof/* input */value === 'string'; }\n";
        const joined = "function accepts(value) { return typeofvalue === 'string'; }\n";
        expect(dirs.digestSource(separated)).to.not.equal(dirs.digestSource(joined));
        expect(dirs.digestSource('function f(a, b) { return a-/**/-b; }\n'))
            .to.not.equal(dirs.digestSource('function f(a, b) { return a--b; }\n'));
    });

    it('preserves the intended separator for LF and CRLF source', function () {
        const commented = "function accepts(value) { return typeof/* input */value === 'string'; }\r\n";
        const separated = "function accepts(value) { return typeof value === 'string'; }\r\n";
        const joined = "function accepts(value) { return typeofvalue === 'string'; }\r\n";
        expect(dirs.digestSource(commented)).to.equal(dirs.digestSource(separated));
        expect(dirs.digestSource(commented)).to.not.equal(dirs.digestSource(joined));
    });

    it('moves a directory handler pin for the collision', function () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-token-boundary-'));
        put(root, 'src/actions/fixture/index.js', "module.exports = require('./validate.js');\n");
        put(root, 'src/actions/fixture/validate.js', 'module.exports = value => typeof/* input */value;\n');
        const commented = directoryPin(root);
        put(root, 'src/actions/fixture/validate.js', 'module.exports = value => typeofvalue;\n');
        expect(directoryPin(root)).to.not.equal(commented);
    });
});
