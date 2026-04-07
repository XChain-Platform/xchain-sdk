/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Interactive REPL
 *
 * Drops developers into an interactive session with a pre-configured
 * SDK instance for exploration and prototyping.
 *
 * Usage:
 *   npm run repl
 *   node -e "require('./src/repl').startREPL({ network: 'bitcoin-regtest' })"
 *
 ********************************************************************/

const repl = require('repl');
const XChainSDK = require('./XChainSDK.js');
const CrossChainHelper = require('./crossChain.js');


async function startREPL(options = {}) {

    // Build options from env vars and explicit options
    let sdkOptions = {
        network:     options.network     || process.env.NETWORK     || 'bitcoin-regtest',
        explorerUrl: options.explorerUrl || process.env.EXPLORER_URL,
        explorerPort: options.explorerPort || process.env.EXPLORER_PORT,
        encoderUrl:  options.encoderUrl  || process.env.ENCODER_URL,
        encoderPort: options.encoderPort || process.env.ENCODER_PORT,
        hubUrl:      options.hubUrl      || process.env.HUB_URL,
        ...options
    };

    let sdk = new XChainSDK(sdkOptions);

    // Try hub init if configured
    if (sdk.hub) {
        try {
            await sdk.init();
            console.log('Hub connected and config loaded.');
        } catch (e) {
            console.log('Hub connection failed: ' + e.message);
        }
    }

    console.log('');
    console.log('  XChain SDK REPL');
    console.log('  Network: ' + sdkOptions.network);
    console.log('');
    console.log('  Available in scope:');
    console.log('    sdk            - XChainSDK instance');
    console.log('    session(wif)   - Create a WalletSession');
    console.log('    keygen()       - Generate a new keypair');
    console.log('');
    console.log('  Commands:');
    console.log('    .actions       - List all action types');
    console.log('    .status        - Show SDK configuration');
    console.log('    .fields ACTION - Show fields for an action');
    console.log('');

    let server = repl.start({
        prompt: 'xchain> ',
        useGlobal: false,
        // Enable await in REPL
        breakEvalOnSigint: true
    });

    // Inject helpers into context
    server.context.sdk     = sdk;
    server.context.session = (wif, opts) => sdk.session(wif, opts);
    server.context.keygen  = () => sdk.generateKeyPair();
    server.context.CrossChainHelper = CrossChainHelper;

    // Custom commands
    server.defineCommand('actions', {
        help: 'List all available action types',
        action() {
            let actions = sdk.getActions();
            console.log('\n  ' + actions.join(', ') + '\n');
            console.log('  ' + actions.length + ' actions available\n');
            this.displayPrompt();
        }
    });

    server.defineCommand('status', {
        help: 'Show SDK configuration status',
        action() {
            console.log('');
            console.log('  Network:   ' + sdkOptions.network);
            console.log('  Explorer:  ' + (sdk.explorer ? sdk.explorer.baseUrl + ':' + sdk.explorer.port : 'not configured'));
            console.log('  Encoder:   ' + (sdk.encoder ? sdk.encoder.baseUrl + ':' + sdk.encoder.port : 'not configured'));
            console.log('  WebSocket: ' + (sdk.ws ? (sdk.ws.isConnected() ? 'connected' : 'disconnected') : 'not configured'));
            console.log('  Hub:       ' + (sdk.hub ? 'configured' : 'not configured'));
            console.log('');
            this.displayPrompt();
        }
    });

    server.defineCommand('fields', {
        help: 'Show fields for an action (e.g., .fields SEND)',
        action(action) {
            if (!action) {
                console.log('  Usage: .fields ACTION_NAME');
                this.displayPrompt();
                return;
            }
            try {
                let formats = sdk.getActionFormats(action.toUpperCase());
                if (!formats) {
                    console.log('  Unknown action: ' + action);
                } else {
                    console.log('');
                    for (let version in formats) {
                        console.log('  v' + version + ': ' + formats[version]);
                    }
                    console.log('');
                }
            } catch (e) {
                console.log('  Error: ' + e.message);
            }
            this.displayPrompt();
        }
    });

    // Clean shutdown
    server.on('exit', () => {
        sdk.stop();
        process.exit(0);
    });

    return server;
}


// CLI entry point: run directly with `node src/repl.js`
if (require.main === module) {
    startREPL().catch(err => {
        console.error('REPL failed to start:', err.message);
        process.exit(1);
    });
}


module.exports = { startREPL };
