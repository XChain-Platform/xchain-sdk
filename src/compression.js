// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/compression.js working for published consumers
// that deep-import it. The module itself lives at src/protocol/compression.js.
module.exports = require('./protocol/compression.js');
