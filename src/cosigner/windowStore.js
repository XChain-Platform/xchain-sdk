// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/cosigner/windowStore.js working for published consumers
// that deep-import it. The module itself lives at src/cosigner/window_store.js.
module.exports = require('./window_store.js');
