// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/cosigner/coSigner.js working for published consumers
// that deep-import it. The module itself lives at src/cosigner/co_signer.js.
module.exports = require('./co_signer.js');
