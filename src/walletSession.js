// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/walletSession.js working for published consumers
// that deep-import it. The module itself lives at src/utils/wallet_session.js.
module.exports = require('./utils/wallet_session.js');
