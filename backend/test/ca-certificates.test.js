// Certificate posture check: pasted CA certificates are parsed on the server (subject, validity,
// CA flag, SHA-256 fingerprint). The fixtures are throwaway self-signed test certificates
// (public parts only) generated for this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectCaCertificates } = require('../lib/pure');

const CA = "-----BEGIN CERTIFICATE-----\nMIIBxDCCAWmgAwIBAgIUS/G/dX5IEtt7Tp5XOnPkR2+KffowCgYIKoZIzj0EAwIw\nNjEXMBUGA1UEAwwOVGVzdCBEZXZpY2UgQ0ExGzAZBgNVBAoMEm5ldGJpcmQtbG9n\ncyB0ZXN0czAgFw0yNjEwMjkwMjExNDVaGA8yMTI2MTAwNTAyMTE0NVowNjEXMBUG\nA1UEAwwOVGVzdCBEZXZpY2UgQ0ExGzAZBgNVBAoMEm5ldGJpcmQtbG9ncyB0ZXN0\nczBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABLtU1ZfiA25OePwmvKRWbmKatSI4\nPEEa2cTupXI2wcyKVAwUH/6mnyude39oUNNDYKMmZiy60DMLhxFhAyoSHXGjUzBR\nMB0GA1UdDgQWBBSTCaXPMc9OV6hKN+54NM05V5CgUTAfBgNVHSMEGDAWgBSTCaXP\nMc9OV6hKN+54NM05V5CgUTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kA\nMEYCIQDQj23DDtQnaopuUMv23Y4o1+cpSpLDOmS8yJRCDiUmDAIhAM6/PaXj5diO\n1aCjY/T03KihSpYdJXdor/lc4wwbLWzN\n-----END CERTIFICATE-----";
const LEAF = "-----BEGIN CERTIFICATE-----\nMIIBfDCCASKgAwIBAgIUXMmAp+uDd7MsQJFc1uULst8GbogwCgYIKoZIzj0EAwIw\nFDESMBAGA1UEAwwJVGVzdCBMZWFmMCAXDTI2MTAyOTAyMTE0NVoYDzIxMjYxMDA1\nMDIxMTQ1WjAUMRIwEAYDVQQDDAlUZXN0IExlYWYwWTATBgcqhkjOPQIBBggqhkjO\nPQMBBwNCAAQ71lTVNm5OEIhh2uij9N0WKL4gGxQKorfsdJ1wz7GjmVgVOSOpVu35\nNt4AqPLZj+2cU3LxXII+NgF/Uqcd5Ju8o1AwTjAdBgNVHQ4EFgQUUcIeC2r0UBgJ\n3B82N7xb41nMoXUwHwYDVR0jBBgwFoAUUcIeC2r0UBgJ3B82N7xb41nMoXUwDAYD\nVR0TAQH/BAIwADAKBggqhkjOPQQDAgNIADBFAiByr4eFTO/M9oMB+428ByAjEwUm\nj+HdZ6Le/UC2Ymo/YAIhAK7bIfPLX9Ge2RigZunAbAAuvlbF4WNXFaMEbXLUG9pj\n-----END CERTIFICATE-----";

test('a CA certificate yields its subject, CA flag and SHA-256 fingerprint', () => {
    const [r] = inspectCaCertificates([CA]);
    assert.equal(r.ok, true);
    assert.equal(r.isCA, true);
    assert.equal(r.expired, false);
    assert.match(r.subject, /CN=Test Device CA/);
    assert.equal(r.fingerprint256, '49:07:45:AF:45:39:16:E8:2A:88:71:E7:6F:18:50:C2:94:FF:D6:E8:5E:8E:A8:A2:5F:24:0B:1C:C3:3E:B5:5C');
});

test('CRLF line endings and surrounding whitespace are accepted', () => {
    const [r] = inspectCaCertificates(['  ' + CA.replace(/\n/g, '\r\n') + '\r\n\r\n']);
    assert.equal(r.ok, true);
});

test('a non-CA certificate parses but is flagged', () => {
    const [r] = inspectCaCertificates([LEAF]);
    assert.equal(r.ok, true);
    assert.equal(r.isCA, false);
});

test('garbage, empty, truncated and bundled input give a readable error per entry', () => {
    const out = inspectCaCertificates(['hello', '', CA.slice(0, 200) + '\n-----END CERTIFICATE-----', CA + '\n' + LEAF, 42]);
    assert.deepEqual(out.map((r) => r.ok), [false, false, false, false, false]);
    assert.match(out[0].error, /valid PEM/);
    assert.match(out[3].error, /2 certificates/);
    for (const r of out) assert.equal(typeof r.error, 'string');
});

test('input is capped (20 entries, 16k characters each)', () => {
    assert.equal(inspectCaCertificates(new Array(25).fill(CA)).length, 20);
    assert.match(inspectCaCertificates(['x'.repeat(20000)])[0].error, /too long/);
    assert.deepEqual(inspectCaCertificates(null), []);
});
