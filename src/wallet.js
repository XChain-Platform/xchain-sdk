// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/wallet.js working for published consumers that
// deep-import it. The module itself lives at src/utils/wallet.js.
module.exports = require('./utils/wallet.js');
