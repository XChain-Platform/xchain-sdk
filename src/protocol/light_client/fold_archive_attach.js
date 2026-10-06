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
 * XChain SDK - Light Client: attach a v3 wrapper's folded archive
 *
 * The indexer stores a folded ANCHOR v3 action as one row per chain section with
 * the fold fields null, plus one chain-less archive row that carries the fold
 * fields and the wrapper section's own signature list. The wrapper signed over
 * that archive too, so its checkpoint only verifies once the fold is attached.
 *
 ********************************************************************/

'use strict';

const { lowerHex, baseUrl, fetchJson } = require('./fetch_helpers.js');

const FOLD_FIELDS = ['match_batch_seq', 'match_count', 'batch_crc32', 'total_chunks'];

// Read a signature list in either explorer shape (a JSON string on a list row, an
// array on a detail section) as one ordered, lowercased key; null when empty or junk.
function signatureKey(sigs){
    let list = sigs;
    if (typeof list === 'string'){ try { list = JSON.parse(list); } catch (e){ return null; } }
    if (!Array.isArray(list) || !list.length) return null;
    return JSON.stringify(list.map((s) => [lowerHex(s && s.pubkey), lowerHex(s && s.sig)]));
}

// Attach the fold from the ONE chain-less archive row whose signature list equals this
// section's. No wrapper index is stored, so that equality is the only link; zero or two
// candidates attach nothing, and the caller then fails closed on quorum.
function attachFoldArchive(cp, sections){
    if (!cp || cp.fold_archive || !Array.isArray(sections)) return cp;
    const want = signatureKey(cp.validator_signatures);
    if (want === null) return cp;
    const matches = sections.filter((s) => s && (s.chain == null || String(s.chain) === '') &&
        FOLD_FIELDS.every((field) => s[field] != null) && signatureKey(s.validator_signatures) === want);
    if (matches.length !== 1) return cp;
    const a = matches[0];
    cp.fold_archive = { match_batch_seq: a.match_batch_seq, match_count: a.match_count,
        batch_crc32: lowerHex(a.batch_crc32), total_chunks: a.total_chunks };
    return cp;
}

// Read the anchor's detail record (every row of the action) and attach the wrapper fold.
// Never trusted: the fold fields sit inside the signed bytes, so a wrong value fails
// Ed25519, and any fetch failure leaves cp as it was, which fails closed on quorum.
async function attachFoldArchiveFromExplorer(f, opts, dogeCoin, rec, cp){
    const ref = (rec.action_index != null) ? rec.action_index : rec.tx_hash;
    if (ref == null) return cp;
    try {
        const url = baseUrl(opts.explorerUrl) + '/' + encodeURIComponent(String(dogeCoin)) +
                    '/api/anchor/' + encodeURIComponent(String(ref));
        const body = await fetchJson(f, url);
        // Accept the record itself, as the explorer serves it, or the record under data/results.
        let row = (body && Array.isArray(body.sections)) ? body : ((body && (body.data || body.results)) || null);
        if (Array.isArray(row)) row = row[0];
        return attachFoldArchive(cp, row && row.sections);
    } catch (e){
        return cp;
    }
}

module.exports = { attachFoldArchive, attachFoldArchiveFromExplorer };
