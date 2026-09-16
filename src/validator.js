// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/validator.js working for published consumers
// that deep-import it. The module itself lives at src/protocol/validator.js.
module.exports = require('./protocol/validator.js');
