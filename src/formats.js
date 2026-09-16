// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/formats.js working for published consumers
// that deep-import it. The module itself lives at src/protocol/formats.js.
module.exports = require('./protocol/formats.js');
