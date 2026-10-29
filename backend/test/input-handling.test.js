// Input handling flagged by code scanning: the /login returnTo guard, the backup decoder's
// type check, and the linear-time replacements for regexes that could backtrack badly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { safeReturnTo, tgFirstLine, isPlausibleEmail, routingPeerName } = require('../lib/pure');
const { _internal } = require('../db');
const { encryptPrivateKey, encryptBackup, decryptBackup, normMspDigest } = _internal;

// ── /login ?returnTo= ──
const PLACEHOLDER = 'http://app.invalid';
const BASE = 'https://nb.example.com';

test('returnTo: same-app paths are kept as is', () => {
    assert.equal(safeReturnTo('/ok?x=1#h', PLACEHOLDER), '/ok?x=1#h');
    assert.equal(safeReturnTo('/peers', BASE), '/peers');
    assert.equal(safeReturnTo('/', PLACEHOLDER), '/');
    // An absolute URL on the trusted origin itself comes back as its path.
    assert.equal(safeReturnTo('https://nb.example.com/networks?id=1', BASE), '/networks?id=1');
});

test('returnTo: other origins and host-looking paths fall back to Home', () => {
    for (const rt of [
        '/\t/evil.example',       // the URL parser drops the tab: '//evil.example'
        '/\\evil',                // a backslash counts as a slash: '//evil'
        '//evil',
        'https://evil',
        '/a/..//evil.example',    // normalizes to '//evil.example'
        '/.//evil.example',       // normalizes to '//evil.example'
        '/a/%2e%2e//evil.example', // encoded '..' segment, same result
        '/a/%2E%2E//evil.example',
        'javascript:alert(1)',
    ]) {
        assert.equal(safeReturnTo(rt, PLACEHOLDER), '/', JSON.stringify(rt));
        assert.equal(safeReturnTo(rt, BASE), '/', JSON.stringify(rt));
    }
    // The placeholder origin is only a reference point - naming it is not a way out either.
    assert.equal(safeReturnTo('https://nb.example.com/x', PLACEHOLDER), '/');
});

test('returnTo: encoded slashes and dot segments stay on this app', () => {
    // %2F is not a separator, so this is a single same-origin path segment.
    assert.equal(safeReturnTo('/%2F%2Fevil', PLACEHOLDER), '/%2F%2Fevil');
    assert.equal(safeReturnTo('/a/%2e%2e/peers', PLACEHOLDER), '/peers');
});

test('returnTo: non-strings, invalid URLs and oversized values fall back to Home', () => {
    for (const rt of [undefined, null, 42, ['/peers'], { a: '/peers' }]) assert.equal(safeReturnTo(rt, PLACEHOLDER), '/');
    assert.equal(safeReturnTo('http://[', PLACEHOLDER), '/');
    assert.equal(safeReturnTo('/' + 'a'.repeat(2999), PLACEHOLDER), '/');
    assert.equal(safeReturnTo('/' + 'a'.repeat(2047), PLACEHOLDER), '/' + 'a'.repeat(2047));
});

// ── Backup file decoding ──
const CORRUPT = /Wrong passphrase or corrupted file/;
let fixture;
function backupFixture() {
    if (fixture) return fixture;
    const passphrase = 'correct horse battery staple';
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
    const privBlob = Buffer.from(encryptPrivateKey(kp.privateKey.export({ type: 'pkcs8', format: 'der' }), passphrase), 'base64');
    const payload = { kind: 'internal-backup', settings: { a: '1' } };
    fixture = { passphrase, payload, file: encryptBackup(payload, pub, privBlob) };
    return fixture;
}

test('backup: a valid file round-trips; a wrong passphrase is refused', () => {
    const { passphrase, payload, file } = backupFixture();
    assert.deepEqual(decryptBackup(file, passphrase, null), payload);
    assert.throws(() => decryptBackup(file, 'not the passphrase', null), (e) => CORRUPT.test(e.message) && e.status === 400);
});

test('backup: anything but a non-empty Buffer is refused with the same generic error', () => {
    const { passphrase, file } = backupFixture();
    const bufferLike = { length: file.length, subarray: (...a) => file.subarray(...a), readUInt16BE: (o) => file.readUInt16BE(o) };
    for (const input of [file.toString('latin1'), [...file], bufferLike, null, undefined, Buffer.alloc(0)]) {
        assert.throws(() => decryptBackup(input, passphrase, null), (e) => CORRUPT.test(e.message) && e.status === 400);
    }
});

// ── Telegram outbound-log subject ──
test('tgFirstLine: strips tags and returns the first non-empty line', () => {
    assert.equal(tgFirstLine('<b>Peer offline</b>: <code>srv-1</code>\nmore'), 'Peer offline: srv-1');
    assert.equal(tgFirstLine('\n  \n<b><i>Nested</i> tags</b>'), 'Nested tags');
    assert.equal(tgFirstLine('<a href="x">link</a> text'), 'link text');
});

test('tgFirstLine: an unclosed < drops the rest of its line; no < reaches the output', () => {
    assert.equal(tgFirstLine('kept <b unclosed\nnext'), 'kept');
    assert.equal(tgFirstLine('<'.repeat(100000)), '');
    assert.equal(tgFirstLine('<<script>script>alert(1)'), 'script>alert(1)');
    assert.ok(!tgFirstLine('a <<script>b> c').includes('<'));
});

test('tgFirstLine: empty input', () => {
    assert.equal(tgFirstLine(''), '');
    assert.equal(tgFirstLine(undefined), '');
    assert.equal(tgFirstLine('<b></b>'), '');
    assert.equal(tgFirstLine({ length: 1e9 }), '');
});

// ── E-mail address check (invite form, MSP digest recipients) ──
test('email: accepts what the former pattern accepted', () => {
    for (const ok of ['a@b.co', 'first.last+tag@sub.example.com', 'x@y.z', 'a@b..c', 'a@.b.c']) assert.equal(isPlausibleEmail(ok), true, ok);
    for (const bad of ['', 'a@b', 'a@.b', 'a@b.', '@b.co', 'a@@b.co', 'a@b@c.co', 'a b@c.co', 'a@b.c\t', 'a@b.c ', 'plain']) {
        assert.equal(isPlausibleEmail(bad), false, JSON.stringify(bad));
    }
    assert.equal(isPlausibleEmail(['a@b.co']), false);
    assert.equal(isPlausibleEmail(null), false);
});

test('email: 254 characters is the limit, and longer input is refused, not truncated', () => {
    const at254 = 'a'.repeat(254 - '@b.co'.length) + '@b.co';
    assert.equal(at254.length, 254);
    assert.equal(isPlausibleEmail(at254), true);
    assert.equal(isPlausibleEmail('a' + at254), false);
    assert.equal(isPlausibleEmail('!@!.' + '!.'.repeat(50000)), false);
});

test('email: MSP digest keeps only valid recipients', () => {
    const cfg = normMspDigest({ emails: ['ops@example.com', 'bad', 'x'.repeat(250) + '@b.co', ' ops@example.com '] });
    assert.deepEqual(cfg.emails, ['ops@example.com']);
});

// ── Routing peer name in NetBird notifications ──
test('routing peer: name from the disconnect and remove messages', () => {
    assert.equal(routingPeerName('Routing peer my-router has disconnected from the network'), 'my-router');
    assert.equal(routingPeerName('routing peer Office GW was removed'), 'Office GW');
    assert.equal(routingPeerName('Routing peer  was removed from the network'), '');
    assert.equal(routingPeerName('Routing peer has disconnected'), '');
    assert.equal(routingPeerName('Peer my-router has disconnected'), '');
    assert.equal(routingPeerName('Routing peer hasty-box was removed'), 'hasty-box');
    assert.equal(routingPeerName(''), '');
});

test('routing peer: long whitespace runs stay linear and only the first 512 chars are read', () => {
    assert.equal(routingPeerName('Routing peer' + ' '.repeat(200000)), '');
    assert.equal(routingPeerName('Routing peer' + ' '.repeat(200000) + 'x has'), '');
    assert.equal(routingPeerName('Routing peer ' + 'r'.repeat(400) + ' has disconnected'), 'r'.repeat(400));
});
