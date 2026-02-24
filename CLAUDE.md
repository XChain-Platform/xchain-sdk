# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the API server
npm run api
# equivalent to: node ./src/api.js

# Docker (requires external xchain_network to exist)
docker-compose up --build
```

There is no test runner configured. The `devDependencies` in `package.json` is empty.

## Architecture

The SDK has two entry points that serve different purposes:

- **`src/api.js`** — Express HTTP server entry point. Loads `.env`, starts a JSON-RPC API on `SDK_API_PORT` (default 3005), and instantiates `XChainSDK`. Currently only exposes a `ping` method.
- **`src/XChainSDK.js`** — Core SDK class. Instantiates `Utility` and `Actions`, then runs a polling loop checking `stopFlag` every `STOP_CHECK_INTERVAL` (5s).

### Module relationships

```
api.js
  └── XChainSDK.js
        ├── config.js    (getConfig → config object passed to Actions + Utility)
        ├── utility.js   (Utility class — math, validation, format helpers)
        └── actions.js   (Actions class — createAction, uses util + formats)
              └── formats.js  (imported by utility.js — action format definitions)
```

### Action format system (`src/formats.js`)

`formats.js` exports a plain object where each key is an action name (e.g. `BROADCAST`, `ISSUE`, `SEND`) and each value is an object mapping integer version numbers to pipe-delimited field strings:

```js
BROADCAST: {
    0: 'VERSION|MESSAGE|VALUE',
    1: 'VERSION|MESSAGE|VALUE|FEE|MEMO',
    ...
}
```

`utility.js` consumes formats via:
- `getActions()` — returns list of all action names
- `getActionFormats(action)` — returns the version map for an action
- `getActionFormatFieldList(action, version)` — returns deduplicated array of field names for a specific action+version

### Config (`src/config.js`)

Returns a static config object (no external reads). Key entries:
- `NUMBER_FIELDS` — field names that should be cast to numeric types
- `LOCK_FIELDS` — boolean lock flag field names
- `LIST_FIELDS` — list-type field names (`ALLOW_LIST`, `BLOCK_LIST`)
- `STOP_CHECK_INTERVAL` — polling interval in ms (5000)

### Utility big-number math

`utility.js` wraps `mathjs` bignumber operations for precision arithmetic: `bcadd`, `bcsub`, `bcmul`, `bcdiv`, `bcformat`, `bcnum`. All accept optional `decimals` parameter for fixed-point output.

## Environment

`.env` is gitignored. Required variables:
- `SDK_API_PORT` — port for the Express JSON-RPC server (default: 3005)

## Current state

The SDK is early-stage. `actions.js` `createAction()` is stubbed (logs request, no encoding). TODO items: balances API, full action encoding/transaction generation.
