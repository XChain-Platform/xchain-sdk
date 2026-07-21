# Pre-flight ↔ indexer-handler drift map

The Tier-2 client checks in `checks/` mirror validity logic that lives
authoritatively in `xchain-indexer/src/actions/*.js`. When an indexer
handler's validity logic changes, the corresponding client check can
silently drift out of ground-truth, so the drift gate
(`bin/check-preflight-drift.js`, wired into CI) fails when any mapped
indexer handler's SHA-256 changes without a matching update here.

To resolve a drift-gate failure: re-read the changed handler, update the
client check (or confirm no client-visible logic changed), then refresh
the hash below and re-run `node bin/check-preflight-drift.js`.

Ground-truthed against HEAD 2026-07-20. Hashes are of the indexer
handler source files, resolved via `XCHAIN_INDEXER_PATH` or the sibling
`../xchain-indexer` checkout. The gate SKIPS (does not fail) when no
indexer checkout is present, so single-repo CI stays green; the sibling
CI job enforces it.

| Client check module | Indexer handler | SHA-256 |
|---|---|---|
| `checks/send.js` (SEND) | `src/actions/send.js` | `a3ec6399d49d37f3f66fc8038a20748d9a2cb5a30f25e82c9017bee1fdf570f8` |
| `checks/send.js` (DESTROY) | `src/actions/destroy.js` | `effe81706519b936fc59a6f3313ee54851830f3fcd5e68fb918e5972df53092a` |
| `checks/mint.js` | `src/actions/mint.js` | `d7f3d36f024c7a654018b1f62ce5a510508a2386ca998c8829d023a5d1ef4de1` |
| `checks/issue.js` | `src/actions/issue.js` | `936fb032d45cac17c51019dc57f4a7c96642c92d9760e471102e41b7fd72294e` |
| `checks/dispenser.js` (open/edit/close) | `src/actions/dispenser.js` | `065f09fede5feeb3026b6e2d546638ffb0287f8095ee8146f9addfbd5a1ebef9` |
| `checks/dispenser.js` (DISPENSE) | `src/actions/dispense.js` | `0205deffcb56debd2dfd5839b9379629708fb24ab548b27cc64f5547a03106f9` |
| `checks/trading.js` (ORDER) | `src/actions/order.js` | `b00096b9f9c8d4cd077d64cd3132ed8ba6754721c736020f73ab3534547f8b33` |
| `checks/trading.js` (SWAP) | `src/actions/swap.js` | `31090210670f290d6cf60f49939bc0f46a526f747bf9dd1354dec1030b3cd80f` |
| `checks/airdrop.js` | `src/actions/airdrop.js` | `e8aa4a881f6c9b9518db75042b6adfc0d52978ff75153ae9e3feba10437444e9` |
| `checks/dividend.js` | `src/actions/dividend.js` | `0a4f60e890b806f33039065927706720c48477e2c39ec538f6eb1126ff4ed64b` |
| `checks/batch.js` | `src/actions/batch.js` | `58269829cb68f5065256544ba134fda0f1dc00491653d25b4b330f1ec035ef64` |

Actions covered by `checks/misc.js` (unverified-only, no client validity
logic) are intentionally NOT mapped: there is nothing to drift from.
