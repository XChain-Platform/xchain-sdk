// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/batchLimits.js working for published consumers
// that deep-import it. The module itself lives at src/protocol/batch_limits.js.
module.exports = require('./protocol/batch_limits.js');
