#!/usr/bin/env node
// Release helper shared by scripts/release.sh and the release workflows.
//
//   check-version X.Y.Z        exit 0 when X.Y.Z is a stable version (no pre-release, no build
//                              metadata, no leading zeros)
//   gt A B                     exit 0 when stable version A is greater than stable version B
//   max V...                   print the highest stable version of the arguments (others are ignored)
//   section NAME [file]        print the body of the "## [NAME]" section; exit 1 when it is missing
//                              or has no content
//   cut X.Y.Z DATE [file]      turn "## [Unreleased]<suffix>" into "## [X.Y.Z] - DATE<suffix>" and
//                              add a fresh empty "## [Unreleased]" above it
//
// Exit codes: 0 ok, 1 check failed, 2 usage error. CHANGELOG.md may use LF or CRLF line endings;
// `cut` keeps the file's own line endings.
'use strict';

const fs = require('fs');

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEADING = /^## \[([^\]]+)\](.*)$/;

class UsageError extends Error {}
class CheckError extends Error {}

function isStable(v) {
    return typeof v === 'string' && STABLE.test(v);
}

// Compare two stable versions numerically (BigInt, so long components can't lose precision).
function compare(a, b) {
    const pa = a.split('.').map(BigInt);
    const pb = b.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
    }
    return 0;
}

function maxVersion(versions) {
    const stable = versions.filter(isStable);
    if (!stable.length) return null;
    return stable.reduce((best, v) => (compare(v, best) > 0 ? v : best));
}

// A section's line range: from its "## [name]" heading up to the next "## " heading (exclusive).
// The name must match exactly, so 2.1.1 never matches 2.1.10.
function findSection(lines, name) {
    const starts = [];
    lines.forEach((line, i) => {
        const m = HEADING.exec(line);
        if (m && m[1] === name) starts.push(i);
    });
    if (starts.length > 1) throw new CheckError(`CHANGELOG.md has ${starts.length} "## [${name}]" sections`);
    if (!starts.length) return null;
    const start = starts[0];
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end++;
    return { start, end, suffix: HEADING.exec(lines[start])[2] };
}

// Content means a line that is not blank, not a "---" rule and not a heading.
function hasContent(bodyLines) {
    return bodyLines.some((line) => {
        const t = line.trim();
        return t !== '' && !/^-{3,}$/.test(t) && !/^#{1,6}(\s|$)/.test(t);
    });
}

// Body of a section without its heading, trimmed of leading/trailing blank lines and rules.
function sectionBody(text, name) {
    const lines = text.split(/\r?\n/);
    const sec = findSection(lines, name);
    if (!sec) throw new CheckError(`CHANGELOG.md has no "## [${name}]" section`);
    const body = lines.slice(sec.start + 1, sec.end);
    if (!hasContent(body)) throw new CheckError(`The "## [${name}]" section in CHANGELOG.md is empty`);
    const isEdge = (l) => l.trim() === '' || /^-{3,}$/.test(l.trim());
    while (body.length && isEdge(body[0])) body.shift();
    while (body.length && isEdge(body[body.length - 1])) body.pop();
    return body.join('\n') + '\n';
}

function cut(text, version, date) {
    if (!isStable(version)) throw new UsageError(`"${version}" is not a stable X.Y.Z version`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`"${date}" is not a YYYY-MM-DD date`);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    if (findSection(lines, version)) throw new CheckError(`CHANGELOG.md already has a "## [${version}]" section`);
    const sec = findSection(lines, 'Unreleased');
    if (!sec) throw new CheckError('CHANGELOG.md has no "## [Unreleased]" section');
    if (!hasContent(lines.slice(sec.start + 1, sec.end))) {
        throw new CheckError('The "## [Unreleased]" section in CHANGELOG.md is empty');
    }
    lines.splice(sec.start, 1, '## [Unreleased]', '', '---', '', `## [${version}] - ${date}${sec.suffix}`);
    return lines.join(eol);
}

function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new CheckError(`Cannot read ${file}: ${e.message}`);
    }
}

function main(argv) {
    const [cmd, ...args] = argv;
    switch (cmd) {
        case 'check-version':
            if (args.length !== 1) throw new UsageError('usage: check-version X.Y.Z');
            if (!isStable(args[0])) throw new CheckError(`"${args[0]}" is not a stable X.Y.Z version`);
            return;
        case 'gt':
            if (args.length !== 2) throw new UsageError('usage: gt A B');
            for (const v of args) if (!isStable(v)) throw new UsageError(`"${v}" is not a stable X.Y.Z version`);
            if (compare(args[0], args[1]) <= 0) throw new CheckError(`${args[0]} is not greater than ${args[1]}`);
            return;
        case 'max': {
            const best = maxVersion(args);
            if (!best) throw new CheckError('no stable version given');
            process.stdout.write(best + '\n');
            return;
        }
        case 'section':
            if (args.length < 1 || args.length > 2) throw new UsageError('usage: section NAME [file]');
            process.stdout.write(sectionBody(readFile(args[1] || 'CHANGELOG.md'), args[0]));
            return;
        case 'cut': {
            if (args.length < 2 || args.length > 3) throw new UsageError('usage: cut X.Y.Z YYYY-MM-DD [file]');
            const file = args[2] || 'CHANGELOG.md';
            fs.writeFileSync(file, cut(readFile(file), args[0], args[1]));
            return;
        }
        default:
            throw new UsageError('commands: check-version, gt, max, section, cut');
    }
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        process.stderr.write(e.message + '\n');
        process.exit(e instanceof UsageError ? 2 : 1);
    }
}

module.exports = { isStable, compare, maxVersion, sectionBody, cut, CheckError, UsageError };
