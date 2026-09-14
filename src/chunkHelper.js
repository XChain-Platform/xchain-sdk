// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/chunkHelper.js working for published consumers
// that deep-import it. The module itself lives at src/contract/chunk_helper.js.
module.exports = require('./contract/chunk_helper.js');
