#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * xchain-mcp: stdio entry point for the XChain MCP server.
 *
 * Zero-config: tools default to the public *.xchain.io hosts per network
 * (R*-prefixed regtest coins default to localhost services; the standard
 * SDK env vars EXPLORER_URL / ENCODER_URL / HUB_API_HOST etc. override).
 *
 * Claude Code:    claude mcp add xchain -- npx -y xchain-mcp
 * Claude Desktop: { "mcpServers": { "xchain": { "command": "xchain-mcp" } } }
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { buildServer } = require('./server.js');

// Optional agent wallet (BOTH must be set, or write tools don't exist):
//   XCHAIN_MCP_WIF     the agent key (never logged, never echoed)
//   XCHAIN_MCP_POLICY  path to the AgentSession policy JSON
function walletFromEnv() {
    const wif = process.env.XCHAIN_MCP_WIF;
    const policyPath = process.env.XCHAIN_MCP_POLICY;
    if (!wif && !policyPath) return null;
    if (!wif || !policyPath) {
        console.error('xchain-mcp: XCHAIN_MCP_WIF and XCHAIN_MCP_POLICY must BOTH be set to enable write tools; starting read-only.');
        return null;
    }
    return { wif, policy: JSON.parse(fs.readFileSync(policyPath, 'utf8')) };
}

async function main() {
    const wallet = walletFromEnv();
    const server = buildServer({ wallet });
    // stdio transport: stdout is the protocol channel; never console.log here.
    await server.connect(new StdioServerTransport());
    console.error(`xchain-mcp ready (stdio${wallet ? ', agent wallet enabled' : ', read-only'})`);
}

main().catch((err) => {
    console.error('xchain-mcp failed to start:', err);
    process.exit(1);
});
