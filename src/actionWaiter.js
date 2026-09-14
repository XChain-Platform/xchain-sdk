// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/actionWaiter.js working for published consumers
// that deep-import it. The module itself lives at src/utils/action_waiter.js.
module.exports = require('./utils/action_waiter.js');
