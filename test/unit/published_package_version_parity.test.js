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
 * This repo publishes TWO packages, @dankest-llc/xchain-sdk and xchain-mcp,
 * and they are released together at ONE version. Nothing enforced it, and they
 * drifted: the root reached 0.12.0 while mcp/package.json sat at 0.11.0 with
 * its dependency on the SDK pinned '^0.11.0' and the lockfile at 0.11.0 on
 * both of its version fields.
 *
 * The dependency range is the half that makes this more than a cosmetic label.
 * A caret range on a 0.x version does NOT cross the minor, so '^0.11.0'
 * EXCLUDES 0.12.0: publishing the SDK at 0.12.0 with that pin unchanged would
 * have left the published MCP server resolving 0.11.x off npm indefinitely,
 * against an SDK it was never tested with. That is a functional break in a
 * shipped artifact, and it is only fixable cheaply BEFORE the tag.
 *
 * Deliberately does NOT require('semver'): it is a transitive package here,
 * not a declared dependency, so a dependency bump could delete it out from
 * under this test. The caret rule is small enough to state exactly.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const SDK_NAME = '@dankest-llc/xchain-sdk';

// Does `^X.Y.Z` admit `version`? Caret keeps the leftmost NON-ZERO field fixed,
// which is why it behaves differently below 1.0.0: ^1.2.3 allows <2.0.0, but
// ^0.11.0 allows only <0.12.0. Anything that is not a plain caret range is a
// deliberate choice a human should look at, so it fails rather than guesses.
function caretAdmits(range, version){
    const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
    if(!m) throw new Error('range is not a plain caret range, review it by hand: ' + range);
    const [rMaj, rMin, rPat] = m.slice(1).map(Number);
    const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
    if(!v) throw new Error('unparseable version: ' + version);
    const [maj, min, pat] = v.slice(1).map(Number);

    const lower = (maj > rMaj) || (maj === rMaj && (min > rMin || (min === rMin && pat >= rPat)));
    if(!lower) return false;
    if(rMaj !== 0)  return maj === rMaj;                 // ^1.2.3 -> <2.0.0
    if(rMin !== 0)  return maj === 0 && min === rMin;    // ^0.11.0 -> <0.12.0
    return maj === 0 && min === 0 && pat === rPat;       // ^0.0.3  -> that patch only
}

describe('published packages carry ONE version', function(){

    const root = read('package.json');
    const mcp  = read('mcp/package.json');
    const lock = read('package-lock.json');

    it('the caret rule this test relies on is the real one', function(){
        // Guards the guard: the exact case that was missed in the wild.
        expect(caretAdmits('^0.11.0', '0.12.0'), '^0.11.0 must NOT admit 0.12.0').to.equal(false);
        expect(caretAdmits('^0.11.0', '0.11.7')).to.equal(true);
        expect(caretAdmits('^0.12.0', '0.12.0')).to.equal(true);
        expect(caretAdmits('^1.2.3',  '1.9.0')).to.equal(true);
        expect(caretAdmits('^1.2.3',  '2.0.0')).to.equal(false);
        expect(caretAdmits('^0.11.0', '0.10.9'), 'below the floor').to.equal(false);
    });

    it('root, mcp and the lockfile all agree', function(){
        const seen = {
            'package.json':                 root.version,
            'mcp/package.json':             mcp.version,
            'package-lock.json .version':   lock.version,
            'package-lock.json packages[""]': lock.packages[''].version
        };
        const distinct = [...new Set(Object.values(seen))];
        expect(distinct, 'one version across every manifest, got ' + JSON.stringify(seen))
            .to.have.length(1);
    });

    it('the MCP dependency range admits the version actually published', function(){
        const range = mcp.dependencies[SDK_NAME];
        expect(range, 'mcp must depend on the SDK').to.be.a('string');
        // The failure this catches: publishing 0.12.0 while the range still says
        // ^0.11.0 leaves the shipped MCP server resolving 0.11.x forever.
        expect(caretAdmits(range, root.version),
            'mcp depends on ' + SDK_NAME + '@' + range + ' which does NOT admit the published ' +
            root.version + '; bump the range with the version')
            .to.equal(true);
    });
});
