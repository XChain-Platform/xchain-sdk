// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/networks.js working for published consumers
// that deep-import it. The module itself lives at src/protocol/networks.js.
module.exports = require('./protocol/networks.js');
