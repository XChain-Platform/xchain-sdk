// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/utility.js working for published consumers
// that deep-import it. The module itself lives at src/utils/utility.js.
module.exports = require('./utils/utility.js');
