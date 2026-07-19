//  doctrine test-coverage program: coverage for the scripts component
// (scripts/sync-templates.js). It self-executes main() on load (reads the
// contract template sources, base64-encodes them, and writes a generated
// module), so running it here would mutate the tree. This pins its structural
// contract by compiling and inspecting the source: it must read the template
// sources, render a module.exports bundle, write the output file, and stay
// offline.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'scripts', 'sync-templates.js');
const source = fs.readFileSync(SRC, 'utf8').replace(/^#!.*\n/, '');

describe('scripts/sync-templates (static contract)', function () {
    it('is syntactically valid JavaScript (compiles without executing)', function () {
        assert.doesNotThrow(() => new vm.Script(source, { filename: 'sync-templates.js' }));
    });

    it('reads template sources and writes a rendered module', function () {
        assert.ok(/readFileSync|readdirSync/.test(source), 'must read template sources');
        assert.ok(/module\.exports/.test(source), 'must render a module.exports bundle');
        assert.ok(/writeFileSync/.test(source), 'must write the generated output');
    });

    it('performs no network I/O (template sync is offline)', function () {
        for (const mod of ['http', 'https', 'net', 'dns']) {
            assert.ok(!new RegExp(`require\\(\\s*['"]${mod}['"]`).test(source),
                `template sync must not require ${mod}`);
        }
    });
});
