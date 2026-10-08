// Non-recursive lexical nesting-depth guard used before either JavaScript parser.
// @ts-nocheck

const acorn = require('acorn');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');
const { LINT_MAX_NESTING_DEPTH } = require('./constants.js');

const OPENERS = new Set(['(', '[', '{', '${']);
const CLOSERS = new Set([')', ']', '}']);

/**
 * Tokenize without building an AST and return the first excessive nesting hit.
 * Nesting is the number of delimiters inside the outermost open delimiter, so
 * a function body containing 64 nested expression delimiters is at the limit.
 * All delimiter families share one counter, preventing mixed nesting from
 * bypassing the limit.
 *
 * @param {string} code
 * @returns {{rule:string,message:string,line:number|null,severity:string}|null}
 */
function findNestingDepthViolation(code) {
    if (typeof code !== 'string') return null;

    let nestingDepth = -1;
    let tokenizer;
    try {
        tokenizer = acorn.tokenizer(code, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            locations: true,
            allowHashBang: true
        });

        for (;;) {
            const token = tokenizer.getToken();
            const label = token.type.label;
            if (label === 'eof') return null;

            if (OPENERS.has(label)) {
                nestingDepth += 1;
                if (nestingDepth > LINT_MAX_NESTING_DEPTH) {
                    const line = token.loc && token.loc.start ? token.loc.start.line : null;
                    return {
                        rule: 'nesting-depth',
                        message: 'nesting depth exceeds limit (' + LINT_MAX_NESTING_DEPTH + ')' +
                            (line === null ? '' : ' at line ' + line),
                        line,
                        severity: 'error'
                    };
                }
            } else if (CLOSERS.has(label)) {
                nestingDepth = Math.max(-1, nestingDepth - 1);
            }
        }
    } catch (e) {
        return null;
    }
}

module.exports = { findNestingDepthViolation };
