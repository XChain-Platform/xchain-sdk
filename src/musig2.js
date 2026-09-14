// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/musig2.js working for published consumers that
// deep-import it. The module itself lives at src/cosigner/musig2.js.
module.exports = require('./cosigner/musig2.js');
