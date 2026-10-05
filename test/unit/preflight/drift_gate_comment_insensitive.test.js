'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dirs = require('../../../bin/preflight_handler_dirs.js');

const SOURCE = [
    "'use strict';",
    "const message = 'invalid: // stays literal';",
    'const template = `rule /* stays literal */`;',
    '// Explain the fixture rule.',
    'function validate(value) {',
    '    /* Require a positive value. */',
    '    return value > 0;',
    '}',
    'module.exports = { message, template, validate };',
    '',
].join('\n');

function fixtureRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'drift-comment-digest-'));
}

function pin(root, source) {
    const handler = path.join(root, 'src', 'actions', 'fixture.js');
    fs.mkdirSync(path.dirname(handler), { recursive: true });
    fs.writeFileSync(handler, source);
    const [row] = dirs.parseMapRows(`| \`checks/x.js\` | \`src/actions/fixture.js\` | \`${'0'.repeat(64)}\` |`);
    return dirs.hashMappedRow(root, row).actual;
}

describe('pre-flight handler digest comment sensitivity', function () {
    let root;

    beforeEach(function () { root = fixtureRoot(); });
    afterEach(function () { fs.rmSync(root, { recursive: true, force: true }); });

    it('keeps the digest for comment-only and line-end whitespace edits', function () {
        const original = pin(root, SOURCE);
        const edited = SOURCE
            .replace('Explain the fixture rule.', 'Describe the same fixture rule differently.\t')
            .replace('Require a positive value.', 'Reject zero and negative values.')
            .replace('return value > 0;', 'return value > 0; \t');
        expect(pin(root, edited)).to.equal(original);
    });

    it('changes the digest when executable code changes', function () {
        const original = pin(root, SOURCE);
        expect(pin(root, SOURCE.replace('value > 0', 'value >= 0'))).to.not.equal(original);
    });

    it('changes the digest for edits inside string and template literals', function () {
        const original = pin(root, SOURCE);
        expect(pin(root, SOURCE.replace('// stays literal', '// changed literal'))).to.not.equal(original);
        expect(pin(root, SOURCE.replace('/* stays literal */', '/* changed literal */'))).to.not.equal(original);
    });
});
