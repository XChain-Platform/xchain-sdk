'use strict';

// Every piece a multipart plan produces must pass the real serializer and its field
// validation: a stubbed createAction let a FILE part reach the rail before the
// validator was seen to demand a TYPE that format 2 does not carry.
const assert = require('assert');
const crypto = require('crypto');
const Actions = require('../../src/actions/index.js');
const Utility = require('../../src/utils/utility.js');
const { planMultipartFile } = require('../../src/file/multipart.js');

function realActions() {
    return new Actions({ config: {}, util: new Utility() });
}

describe('multipart plan pieces through the real serializer', function () {
    it('serializes every part of a three-part plan as FILE format 2', async function () {
        const bytes = crypto.randomBytes(700000);
        const plan = await planMultipartFile(bytes, { name: 'parts.bin', type: 'application/octet-stream' }, {});
        assert.ok(plan.parts.length >= 2, 'the fixture must plan more than one part');
        const actions = realActions();
        for (const part of plan.parts) {
            const { actionString } = actions.createAction({ action: 'FILE', params: part.params });
            assert.match(actionString, /^FILE\|2\|/);
        }
    });

    it('serializes the plan manifest as FILE format 1', async function () {
        const bytes = crypto.randomBytes(700000);
        const plan = await planMultipartFile(bytes, { name: 'manifest.bin', type: 'application/octet-stream' }, {});
        const { actionString } = realActions().createAction({ action: 'FILE', params: plan.manifest.params });
        assert.match(actionString, /^FILE\|1\|/);
    });

    it('still requires TYPE on a single-shot FILE', function () {
        assert.throws(() => realActions().createAction({ action: 'FILE', params: { version: 0, name: 'a.txt', data: 'aa' } }),
            /FILE requires field: TYPE/);
    });
});
