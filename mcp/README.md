# xchain-mcp

Model Context Protocol (MCP) stdio server for the [XChain Platform](https://xchain.io/). Gives MCP clients (Claude Code, Claude Desktop, or any MCP-capable agent) tools to read XChain state on Bitcoin, Litecoin and Dogecoin (mainnet, testnet and local regtest), and, optionally, to submit policy-gated XChain actions.

Backed by [`@dankest-llc/xchain-sdk`](https://www.npmjs.com/package/@dankest-llc/xchain-sdk). Full documentation: <https://docs.xchain.io/ai-agents/mcp-quickstart>.

## Install

```
# Claude Code
claude mcp add xchain -- npx -y xchain-mcp

# Claude Desktop (claude_desktop_config.json)
{ "mcpServers": { "xchain": { "command": "npx", "args": ["-y", "xchain-mcp"] } } }
```

Zero-config: tools default to the public `*.xchain.io` hosts per network. `R*`-prefixed regtest coins default to localhost services; the standard SDK env vars (`EXPLORER_URL`, `ENCODER_URL`, `HUB_API_HOST`, ...) override.

## Write tools are opt-in

The server starts read-only. Write tools are listed only when BOTH are set:

- `XCHAIN_MCP_WIF`: the agent key (never logged, never echoed)
- `XCHAIN_MCP_POLICY`: path to an AgentSession policy JSON

Every submitted action is evaluated against the policy; out-of-policy actions are refused unsigned. Policies requiring human confirmation (`confirmAbove`) are rejected outright, since a stdio server has no human in the loop.

## License

AGPL-3.0-or-later. A commercial license (without AGPL source-disclosure terms) is available: contact legal@dankest.llc.
