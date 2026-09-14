// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/actions.js working for published consumers
// that deep-import it. The module itself lives at src/actions/index.js.
module.exports = require('./actions/index.js');
