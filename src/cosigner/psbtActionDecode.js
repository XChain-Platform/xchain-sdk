// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/cosigner/psbtActionDecode.js working for published consumers
// that deep-import it. The module itself lives at src/cosigner/psbt_action_decode.js.
module.exports = require('./psbt_action_decode.js');
