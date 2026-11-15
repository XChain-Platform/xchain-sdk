#!/usr/bin/env node
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
// Ceremony gate: the npm registry must not lag the repo. Compares each published
// package's package.json version against registry.npmjs.org and exits 1 while any
// of them differs, so an unpublished or half-published cut cannot close a release.
// Network-dependent by design: an unreachable registry also fails, because
// "unverified" is not "in sync".
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const manifests = [
  path.join(__dirname, '..', 'package.json'),
  path.join(__dirname, '..', 'mcp', 'package.json'),
];

let red = false;
for (const manifest of manifests) {
  const { name, version } = require(manifest);
  let published;
  try {
    published = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(`${name}: could not read the registry (${String(err.message).split('\n')[0]})`);
    red = true;
    continue;
  }
  if (published === version) {
    console.log(`${name}: in sync at ${version}`);
  } else {
    console.error(`${name}: repo is at ${version} but the registry serves ${published}`);
    red = true;
  }
}
process.exit(red ? 1 : 0);
