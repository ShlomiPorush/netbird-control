'use strict';
// Run with: node --test .github/scripts/changelog.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isStable, compare, maxVersion, sectionBody, cut, CheckError } = require('./changelog');

const SAMPLE = [
    '# Changelog',
    '',
    'Intro text.',
    '',
    '---',
    '',
    '## [Unreleased] - NetBird v0.81 support',
    '',
    '### Added',
    '- Per-path access.',
    '',
    '---',
    '',
    '## [2.1.10] - 2026-10-01',
    '',
    '### Fixed',
    '- Ten.',
    '',
    '---',
    '',
    '## [2.1.1] - 2026-09-01',
    '',
    '### Fixed',
    '- One.',
    '',
    '## [2.0] - MSP multi-tenancy - 2026-07-22 → 2026-07-29',
    '',
    'Cycle text.',
    '',
].join('\n');

const crlf = (s) => s.replace(/\n/g, '\r\n');

test('stable versions only', () => {
    for (const v of ['0.0.0', '1.2.3', '2.10.0', '10.0.1']) assert.equal(isStable(v), true, v);
    for (const v of ['1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-rc.1', '1.2.3+b1', ' 1.2.3', '1.2.3\n', '']) {
        assert.equal(isStable(v), false, JSON.stringify(v));
    }
});

test('versions compare numerically', () => {
    assert.equal(compare('2.1.10', '2.1.9'), 1);
    assert.equal(compare('2.1.9', '2.1.10'), -1);
    assert.equal(compare('2.10.0', '2.9.99'), 1);
    assert.equal(compare('3.0.0', '3.0.0'), 0);
    assert.equal(compare('1.0.99999999999999999999', '1.0.99999999999999999998'), 1);
});

test('max ignores versions that are not stable', () => {
    assert.equal(maxVersion(['2.1.2', '2.1.10', '2.1.9', '9.9.9-rc.1', 'junk']), '2.1.10');
    assert.equal(maxVersion(['junk']), null);
    assert.equal(maxVersion([]), null);
});

test('section matches the exact version and stops at the next ## heading', () => {
    assert.equal(sectionBody(SAMPLE, '2.1.1'), '### Fixed\n- One.\n');
    assert.equal(sectionBody(SAMPLE, '2.1.10'), '### Fixed\n- Ten.\n');
    assert.equal(sectionBody(SAMPLE, 'Unreleased'), '### Added\n- Per-path access.\n');
    assert.equal(sectionBody(SAMPLE, '2.0'), 'Cycle text.\n');
    assert.throws(() => sectionBody(SAMPLE, '2.1'), CheckError);
    assert.throws(() => sectionBody(SAMPLE, '2.1.0'), CheckError);
});

test('section reads CRLF files the same as LF files', () => {
    assert.equal(sectionBody(crlf(SAMPLE), '2.1.1'), '### Fixed\n- One.\n');
    assert.equal(sectionBody(crlf(SAMPLE), 'Unreleased'), '### Added\n- Per-path access.\n');
});

test('a section with only blank lines, rules or headings is empty', () => {
    for (const body of ['', '   \n\t', '---\n\n-----', '### Added\n\n### Fixed\n---', '###']) {
        const text = `## [Unreleased]\n${body}\n\n## [1.0.0] - 2026-01-01\n- x\n`;
        assert.throws(() => sectionBody(text, 'Unreleased'), /empty/, JSON.stringify(body));
    }
});

test('a duplicated section is refused', () => {
    const text = '## [1.0.0] - a\n- x\n## [1.0.0] - b\n- y\n';
    assert.throws(() => sectionBody(text, '1.0.0'), /2 "## \[1.0.0\]" sections/);
});

test('cut renames Unreleased, keeps its suffix and adds an empty Unreleased', () => {
    const out = cut(SAMPLE, '2.2.0', '2026-11-01');
    const lines = out.split('\n');
    const i = lines.indexOf('## [Unreleased]');
    assert.deepEqual(lines.slice(i, i + 5), ['## [Unreleased]', '', '---', '', '## [2.2.0] - 2026-11-01 - NetBird v0.81 support']);
    assert.equal(sectionBody(out, '2.2.0'), '### Added\n- Per-path access.\n');
    assert.throws(() => sectionBody(out, 'Unreleased'), /empty/);
    // Everything else is untouched.
    assert.equal(out.replace('## [Unreleased]\n\n---\n\n## [2.2.0] - 2026-11-01', '## [Unreleased]'), SAMPLE);
});

test('cut keeps CRLF line endings', () => {
    const out = cut(crlf(SAMPLE), '2.2.0', '2026-11-01');
    assert.equal(out.replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(out.includes('## [2.2.0] - 2026-11-01 - NetBird v0.81 support\r\n'), true);
});

test('cut refuses an empty or missing Unreleased, an existing version and bad input', () => {
    const empty = cut(SAMPLE, '2.2.0', '2026-11-01');
    assert.throws(() => cut(empty, '2.3.0', '2026-11-02'), /empty/);
    assert.throws(() => cut('## [1.0.0] - x\n- a\n', '1.1.0', '2026-11-01'), /no "## \[Unreleased\]"/);
    assert.throws(() => cut(SAMPLE, '2.1.1', '2026-11-01'), /already has/);
    assert.throws(() => cut(SAMPLE, '2.2.0-rc.1', '2026-11-01'), /stable/);
    assert.throws(() => cut(SAMPLE, '2.2.0', '1/11/2026'), /date/);
});

test('command line exit codes', () => {
    const cli = path.join(__dirname, 'changelog.js');
    const run = (...args) => {
        try {
            return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
        } catch (e) {
            return { code: e.status, out: e.stdout };
        }
    };
    assert.equal(run('check-version', '1.2.3').code, 0);
    assert.equal(run('check-version', '1.2.3-rc.1').code, 1);
    assert.equal(run('gt', '2.1.10', '2.1.9').code, 0);
    assert.equal(run('gt', '2.1.2', '2.1.2').code, 1);
    assert.equal(run('gt', 'x', '2.1.2').code, 2);
    assert.deepEqual(run('max', '2.1.2', '2.1.10', 'junk'), { code: 0, out: '2.1.10\n' });
    assert.equal(run('max', 'junk').code, 1);
    assert.equal(run('nope').code, 2);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-test-'));
    try {
        const file = path.join(dir, 'CHANGELOG.md');
        fs.writeFileSync(file, crlf(SAMPLE));
        assert.deepEqual(run('section', '2.1.1', file), { code: 0, out: '### Fixed\n- One.\n' });
        assert.equal(run('section', '9.9.9', file).code, 1);
        assert.equal(run('cut', '2.2.0', '2026-11-01', file).code, 0);
        assert.equal(fs.readFileSync(file, 'utf8').includes('## [2.2.0] - 2026-11-01 - NetBird v0.81 support\r\n'), true);
        assert.equal(run('cut', '2.3.0', '2026-11-02', file).code, 1);
        assert.equal(run('section', '1.0.0', path.join(dir, 'missing.md')).code, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
