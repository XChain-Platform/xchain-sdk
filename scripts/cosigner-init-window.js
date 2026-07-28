#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * Create a fresh co-signer spending window, deliberately.
 *
 * The daemon refuses to start against an ABSENT window file (G6): treating a
 * missing file as an empty window would make `rm` a silent, complete budget
 * reset. Creating one is therefore an explicit operator act, and this is the
 * surface for it.
 *
 *   npm run cosigner:init-window -- /var/lib/xchain-cosigner/window.json 24
 *
 * It refuses to overwrite an existing window: re-initialising a live one is
 * the same budget reset by another name. Move or delete the old file yourself
 * if that is genuinely what you intend.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const WindowStore = require('../src/cosigner/windowStore.js');

const [stateFile, hoursArg] = process.argv.slice(2);

if (!stateFile || !hoursArg) {
    console.error('usage: cosigner-init-window <stateFile> <windowHours>');
    console.error('example: cosigner-init-window /var/lib/xchain-cosigner/window.json 24');
    process.exit(2);
}

const hours = Number(hoursArg);
if (!Number.isFinite(hours) || hours <= 0) {
    console.error(`windowHours must be a positive number (got "${hoursArg}")`);
    process.exit(2);
}

const target = path.resolve(stateFile);
if (fs.existsSync(target)) {
    console.error(`refusing to overwrite an existing window at ${target}.`);
    console.error('Re-initialising a live window restores the full spending budget. Move the old file');
    console.error('aside first if that is deliberate.');
    process.exit(1);
}

const store = new WindowStore(target, hours, null, { init: true });
store.release();

console.log(`created an empty ${hours}h co-signer spending window at ${target} (mode 0600).`);
console.log('The daemon will now start against it; if this file later goes missing the daemon will');
console.log('refuse to serve rather than silently granting a fresh budget.');
