/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The shared checkout-siblings action clones every sibling at one ref, and
 * xchain-contracts master trails its develop, so a tag run tested the template
 * parity guards against stale contracts and the npm publish never happened.
 * publish.yml and the master leg of ci.yml therefore re-pin ../xchain-contracts
 * to the commit recorded in bin/pins/xchain-contracts-commit.txt right after the
 * siblings step. This guard keeps the pin file well formed and the step present
 * and ordered, so a workflow edit cannot quietly drop the fix.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const ROOT = path.resolve(__dirname, '../../..');
const SIBLINGS_STEP = 'Check out declared sibling repositories';
const PIN_STEP = 'Pin xchain-contracts to the tested commit';
const PIN_SCRIPT = 'bin/pin-contracts-sibling.sh';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('xchain-contracts pin for master and tag runs', () => {
    it('keeps a 40-hex commit in the pin file', () => {
        expect(read('bin/pins/xchain-contracts-commit.txt').trim()).to.match(/^[0-9a-f]{40}$/);
    });

    it('ships an executable pin script that reads the pin file and fails loudly', () => {
        const script = path.join(ROOT, PIN_SCRIPT);
        expect(fs.statSync(script).mode & 0o100, 'script is executable').to.not.equal(0);
        const body = fs.readFileSync(script, 'utf8');
        expect(body).to.include('bin/pins/xchain-contracts-commit.txt');
        expect(body).to.include('set -euo pipefail');
        expect(body).to.match(/fetch --quiet --depth 1 origin "\$SHA"/);
    });

    for (const file of ['publish.yml', 'ci.yml']) {
        it(`runs the pin step after the siblings step in ${file}`, () => {
            const text = read(path.join('.github/workflows', file));
            const siblings = text.indexOf(`name: ${SIBLINGS_STEP}`);
            const pin = text.indexOf(`name: ${PIN_STEP}`);
            expect(siblings, 'siblings step present').to.be.greaterThan(-1);
            expect(pin, 'pin step present').to.be.greaterThan(siblings);
            // Same step block: the run line follows the name before any other step starts.
            const block = text.slice(pin).split(/\n {6}- /)[0];
            expect(block).to.include(`run: ${PIN_SCRIPT}`);
        });
    }

    it('limits the ci.yml pin to master so develop keeps testing contracts develop', () => {
        const text = read('.github/workflows/ci.yml');
        const block = text.slice(text.indexOf(`name: ${PIN_STEP}`)).split(/\n {6}- /)[0];
        expect(block).to.include("github.ref == 'refs/heads/master'");
        expect(block).to.include("github.base_ref == 'master'");
    });
});
