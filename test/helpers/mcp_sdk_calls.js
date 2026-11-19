'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'mcp', 'server.js');

// Every SDK method mcp/server.js reaches through sdkFor(coin), read from the source so a
// handler added without a stub fails the roster check instead of passing unexercised.
function sdkMethodsCalledByServer() {
    const src = fs.readFileSync(SERVER, 'utf8');
    return [...new Set([...src.matchAll(/\bsdkFor\(\w+\)\.(\w+)\(/g)].map((m) => m[1]))].sort();
}

module.exports = { sdkMethodsCalledByServer };
