// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/light.js working for published consumers
// that deep-import it. The module itself lives at src/protocol/light_client.js.
module.exports = require('./protocol/light_client.js');
