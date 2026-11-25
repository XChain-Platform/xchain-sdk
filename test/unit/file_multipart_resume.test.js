// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const {
    matchPickedFile,
    confirmResumePlan,
    piecesToSend
} = require('../../src/file/multipart_resume.js');

const ORIGINAL = 'a'.repeat(64);
const PART_DIGESTS = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];

function hashOf(partDigests = PART_DIGESTS) {
    const bytes = partDigests.map((digest) => Buffer.from(digest, 'hex'));
    return crypto.createHash('sha256').update(Buffer.concat(bytes)).digest('hex');
}

function plan() {
    return { totalParts: PART_DIGESTS.length, partDigests: [...PART_DIGESTS] };
}

function part(partIndex, actionIndex, partDigest = PART_DIGESTS[partIndex]) {
    return { kind: 'part', fileHash: hashOf(), partIndex, partDigest, actionIndex };
}

function manifest(actionIndex = 10) {
    return { kind: 'manifest', fileHash: hashOf(), actionIndex };
}

describe('matchPickedFile', function () {
    const record = { originalSha256: ORIGINAL.toUpperCase(), fileHash: 'b'.repeat(64), totalParts: 3 };

    it('matches an upper-case stored digest case-insensitively', function () {
        expect(matchPickedFile([record], ORIGINAL)).to.equal(record);
        expect(matchPickedFile([record], ORIGINAL.toUpperCase())).to.equal(record);
    });

    it('returns null for a non-matching file', function () {
        expect(matchPickedFile([record], 'c'.repeat(64))).to.equal(null);
    });

    it('refuses malformed digests', function () {
        for (const digest of [null, '', 'g'.repeat(64), 'a'.repeat(63)]) {
            expect(() => matchPickedFile([record], digest))
                .to.throw().with.property('code', 'RESUME_BAD_DIGEST');
        }
    });
});

describe('confirmResumePlan', function () {
    const record = { originalSha256: ORIGINAL, fileHash: 'b'.repeat(64), totalParts: 3 };

    it('confirms an unchanged plan and rejects a changed part count', function () {
        expect(confirmResumePlan(record, { fileHash: record.fileHash, totalParts: 3 })).to.equal(true);
        expect(confirmResumePlan(record, { fileHash: record.fileHash, totalParts: 4 })).to.equal(false);
    });

    it('reports both hashes when settings changed the planned hash', function () {
        const changed = 'c'.repeat(64);
        let error;
        try {
            confirmResumePlan(record, { fileHash: changed, totalParts: 3 });
        } catch (caught) {
            error = caught;
        }
        expect(error).to.have.property('code', 'RESUME_PLAN_MISMATCH');
        expect(error.message).to.include(record.fileHash).and.to.include(changed);
    });

    it('returns false when no original-file record matched', function () {
        expect(confirmResumePlan(null, { fileHash: record.fileHash, totalParts: 3 })).to.equal(false);
    });
});

describe('piecesToSend progress', function () {
    it('describes a fresh start', function () {
        expect(piecesToSend(plan(), [])).to.deep.equal({
            manifestSent: false,
            missingParts: [0, 1, 2],
            conflicting: []
        });
    });

    it('describes a half-sent file', function () {
        expect(piecesToSend(plan(), [manifest(), part(0, 11), part(2, 13)])).to.deep.equal({
            manifestSent: true,
            missingParts: [1],
            conflicting: []
        });
    });

    it('describes a complete file', function () {
        expect(piecesToSend(plan(), [manifest(), part(0, 11), part(1, 12), part(2, 13)]))
            .to.deep.equal({ manifestSent: true, missingParts: [], conflicting: [] });
    });
});

describe('piecesToSend conflicts', function () {
    it('uses the lowest action index at a duplicate position', function () {
        const laterConflict = part(1, 50, 'f'.repeat(64));
        const result = piecesToSend(plan(), [laterConflict, part(1, 20)]);
        expect(result.missingParts).to.deep.equal([0, 2]);
        expect(result.conflicting).to.deep.equal([]);
    });

    it('reports the winning wrong digest as conflicting rather than missing', function () {
        const wrong = part(1, 20, 'f'.repeat(64));
        const result = piecesToSend(plan(), [part(1, 50), wrong]);
        expect(result.missingParts).to.deep.equal([0, 2]);
        expect(result.conflicting).to.deep.equal([wrong]);
    });

    it('orders string action indexes numerically, as the explorer returns them', function () {
        const wrong = part(0, '10', 'f'.repeat(64));
        const result = piecesToSend(plan(), [part(0, '9'), wrong]);
        expect(result.conflicting).to.deep.equal([]);
        expect(result.missingParts).to.deep.equal([1, 2]);
        const reversed = piecesToSend(plan(), [wrong, part(0, '9')]);
        expect(reversed.conflicting).to.deep.equal([]);
    });

    it('reports the numerically lower string index as conflicting when its digest is wrong', function () {
        const wrong = part(0, '9', 'f'.repeat(64));
        const result = piecesToSend(plan(), [wrong, part(0, '10')]);
        expect(result.conflicting).to.deep.equal([wrong]);
    });

    it('orders numbers and mixed numbers and strings the same way', function () {
        const wrong = part(0, 100, 'f'.repeat(64));
        expect(piecesToSend(plan(), [part(0, 99), wrong]).conflicting).to.deep.equal([]);
        expect(piecesToSend(plan(), [part(0, '9'), part(0, 10, 'f'.repeat(64))]).conflicting)
            .to.deep.equal([]);
        expect(piecesToSend(plan(), [part(0, 9, 'f'.repeat(64)), part(0, '10')]).conflicting)
            .to.have.length(1);
    });

    it('ignores pieces belonging to another file hash', function () {
        const foreign = { ...part(0, 10), fileHash: 'f'.repeat(64) };
        expect(piecesToSend(plan(), [foreign]).missingParts).to.deep.equal([0, 1, 2]);
    });
});
