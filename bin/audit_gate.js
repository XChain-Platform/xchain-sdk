#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const exceptionsPath = path.join(repoRoot, 'AUDIT-EXCEPTIONS.md');

function usage(message) {
    if (message) console.error(`audit-gate: ${message}`);
    console.error('usage: node bin/audit_gate.js [--input npm-audit.json]');
    process.exit(2);
}

function inputPath(argv) {
    if (argv.length === 0) return null;
    if (argv.length !== 2 || argv[0] !== '--input' || !argv[1]) {
        usage('expected no arguments or one --input path');
    }
    return path.resolve(argv[1]);
}

function identifiers(text) {
    return [...String(text).matchAll(/\b(?:GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,})\b/gi)]
        .map((match) => match[0].toUpperCase());
}

function readExceptions() {
    const markdown = fs.readFileSync(exceptionsPath, 'utf8');
    const accepted = new Set();
    for (const heading of markdown.match(/^##\s+.+$/gm) || []) {
        for (const id of identifiers(heading)) accepted.add(id);
    }
    if (accepted.size === 0) {
        throw new Error('AUDIT-EXCEPTIONS.md has no advisory identifiers in level-two headings');
    }
    return accepted;
}

function runAudit() {
    const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(`npm audit exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    }
    return result.stdout;
}

function readReport(file) {
    const raw = file ? fs.readFileSync(file, 'utf8') : runAudit();
    const report = JSON.parse(raw);
    if (!report || report.auditReportVersion !== 2 || !report.vulnerabilities
        || Array.isArray(report.vulnerabilities) || typeof report.vulnerabilities !== 'object') {
        throw new Error('expected npm audit JSON report version 2');
    }
    return report;
}

function advisoryAccepted(advisory, accepted) {
    const ids = identifiers(`${advisory.url || ''} ${advisory.title || ''}`);
    return ids.length > 0 && ids.every((id) => accepted.has(id));
}

function chainAccepted(name, vulnerabilities, accepted, visiting = new Set()) {
    const vulnerability = vulnerabilities[name];
    if (!vulnerability || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0
        || visiting.has(name)) return false;

    const next = new Set(visiting);
    next.add(name);
    return vulnerability.via.every((cause) => {
        if (typeof cause === 'string') {
            return chainAccepted(cause, vulnerabilities, accepted, next);
        }
        return cause && typeof cause === 'object' && advisoryAccepted(cause, accepted);
    });
}

function main() {
    try {
        const file = inputPath(process.argv.slice(2));
        const accepted = readExceptions();
        const report = readReport(file);
        const severe = Object.entries(report.vulnerabilities)
            .filter(([, vulnerability]) => ['high', 'critical'].includes(vulnerability.severity));
        const ignored = severe.filter(([name]) => chainAccepted(name, report.vulnerabilities, accepted));
        const failures = severe.filter(([name]) => !chainAccepted(name, report.vulnerabilities, accepted));

        if (ignored.length > 0) {
            console.log(`audit-gate: accepted ${ignored.length} high/critical dependency record(s): ${ignored.map(([name]) => name).join(', ')}`);
        }
        if (failures.length > 0) {
            for (const [name, vulnerability] of failures) {
                console.error(`audit-gate: ${vulnerability.severity}: ${name}`);
            }
            console.error(`audit-gate: found ${failures.length} unaccepted high/critical production dependency record(s)`);
            process.exit(1);
        }
        console.log('audit-gate: no unaccepted high or critical production advisories');
    } catch (error) {
        console.error(`audit-gate: ${error.message}`);
        process.exit(2);
    }
}

main();
