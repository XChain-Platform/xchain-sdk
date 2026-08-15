# Audit exceptions

`npm audit` findings that are known, judged, and deliberately not acted on.

The scheduled audit (`.github/workflows/audit.yml`) fails only on **high or
critical advisories in production dependencies**, and its triage convention is
"bump / override / replace, or a documented accept-with-justification". This
file is where the last option is written down. An entry here is not a dismissal
of the finding; it is a record of the reasoning, so the next person to run
`npm audit` and see a red line does not re-derive it from scratch or, worse,
"fix" it by taking advice that makes things worse.

Each entry states what would change the verdict. Review them when that changes,
not on a calendar.

---

## `elliptic` - CVE-2025-14505 / GHSA-848j-6mx2-7j84

**Verdict: REACHABLE, accepted. Not "unreachable" - see below, because the
obvious reading of this one is wrong.**

Recorded 2026-08-15. Severity **low** (CVSS v4 2.9, EPSS 0.167%), and low by
npm's own rating too, so the audit gate is green (`--omit=dev
--audit-level=high` exits 0) and this has never blocked anything.

### What the flaw is

ECDSA **signature generation**: the byte-length of the RFC 6979 nonce `k` is
computed incorrectly, so a `k` whose interim value carries leading zeros gets
truncated. An attacker who obtains BOTH a faulty signature from a vulnerable
version AND a correct signature over identical input can derive the private key.
The advisory also notes the plainer consequence: a truncated nonce produces an
incorrect signature, so legitimate signatures break.

### Why it is reachable here, despite looking transitive and dev-only

The chain is `bitcoinjs-message@2.2.0 -> secp256k1@3.8.1 -> elliptic@6.6.1`, and
`secp256k1@3`'s entry point is:

```js
try { module.exports = require('./bindings') }      // native
catch (err) { module.exports = require('./elliptic') }  // pure JS
```

The fallback is **silent** unless `DEBUG` is set. Measured in this checkout on
2026-08-15: `require('secp256k1/bindings')` throws ("Could not locate the
bindings file"), there is no compiled `.node` under
`node_modules/secp256k1/build/Release/`, and `require('secp256k1/elliptic')`
loads. So the pure-JS path is the live one here, and the vulnerable code runs.

Anyone assuming "native binding, so elliptic is dead weight" is assuming the
build succeeded. Check before repeating that claim; it is environment-dependent
and fails quietly.

The call chain was walked rather than inferred, and can be re-walked:

```
src/auth.js:128            bitcoinMessage.sign(...)
bitcoinjs-message/index.js:130   secp256k1.sign(hash, privateKey, { data })
secp256k1/index.js               require('./bindings') THROWS -> require('./elliptic')
secp256k1/lib/elliptic/index.js:199  exports.sign(message, privateKey, noncefn, data)
                                 -> ec.sign(message, privateKey, { canonical: true, k: noncefn, pers: data })
```

`bitcoinjs-message` passes no custom `noncefn`, so `k` comes from elliptic's own
RFC 6979 generator: the exact code the advisory is about.

### What it touches

Two call sites, both in `src/auth.js`:

- `bitcoinMessage.sign()` (auth.js:128) - **affected**, this is nonce generation.
  Reached through `signMessage()`, and through `x402.js` payment auth.
- `bitcoinMessage.verify()` (auth.js:191) - **not affected**, verification
  generates no nonce.

### Why it is accepted rather than fixed

**There is no fix to take.** Measured 2026-08-15:

- `elliptic@6.6.1` is the newest published release and the advisory covers every
  version. No patched release exists.
- `secp256k1@5.0.1`, the newest major, still depends on `elliptic ^6.5.7`, so
  moving up the chain does not shed it.
- `bitcoinjs-message@2.2.0` declares `secp256k1: ^3.0.1`, so a v5 override is
  outside its range anyway.

**Do not run `npm audit fix --force` here.** It proposes installing
`bitcoinjs-message@1.0.0` against our declared `^2.2.0`: a **downgrade of a
message-signing library**, presented as a fix. That is a larger risk than the
advisory it closes.

### What makes the practical risk low

The key-recovery attack needs a faulty signature *and* a correct one over the
**same** input. Our signer consistently takes the elliptic path where the native
binding is absent, so an attacker collecting our signatures gets faulty ones
only; the correct counterpart would have to come from the same key signing the
same message under a non-vulnerable implementation elsewhere. Combined with the
leading-zero condition on `k` (roughly 1 in 256 for a single leading zero byte,
our estimate, not the advisory's figure), exploitation is remote.

### Tripwire

The correctness half is the more likely way this shows up. If users report
**intermittent** `signMessage` or x402 auth failures at a low rate, with no
pattern in the message content, suspect this before suspecting the auth logic:
a truncated nonce yields an invalid signature roughly that often.

### What would change the verdict

Any one of:

- a patched `elliptic` release appears (then override to it);
- `bitcoinjs-message` publishes a major that moves off `secp256k1@3`, or off
  elliptic entirely;
- the severity is re-rated upward, or the EPSS moves materially;
- we decide to guarantee the native binding is present at install time, which
  removes reachability without touching the dependency;
- the tripwire above fires.
