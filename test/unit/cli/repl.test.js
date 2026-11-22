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
 **********************************************************************/
// Unit coverage for src/cli/repl.js. The developer REPL entry point must load
// without opening an interactive session as a side effect (importing it is
// safe; only startREPL() drops into repl). Pins the exported contract.
// If importing it ever opened a session, any program that merely loads the
// SDK would stop and wait for keyboard input that never comes.

const assert = require('assert');
const mod = require('../../../src/cli/repl.js');

describe('repl', function () {
    it('exports startREPL as a function', function () {
        assert.strictEqual(typeof mod.startREPL, 'function');
    });

    it('requiring the module opens no REPL (no throwing top-level side effect)', function () {
        delete require.cache[require.resolve('../../../src/cli/repl.js')];
        assert.doesNotThrow(() => require('../../../src/cli/repl.js'));
    });
});
