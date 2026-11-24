// The OpenAPI spec is built from the app's own routes, so it has to find them on the router of the
// Express version in use - an empty spec still answers 200, so check its contents.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildOpenApiSpec } = require('../openapi');

function requireAdmin(req, res, next) { next(); }

test('the spec lists the app routes, with path params and the admin-only mark', () => {
    const app = express();
    app.get('/api/health', (req, res) => res.json({}));
    app.post('/api/msp/tenants/:id/token', requireAdmin, (req, res) => res.json({}));
    app.get('/{*splat}', (req, res) => res.end()); // the SPA fallback is not part of the API
    const spec = buildOpenApiSpec(app);
    assert.deepEqual(Object.keys(spec.paths).filter((p) => !p.startsWith('/api/v1/')).sort(), ['/api/health', '/api/msp/tenants/{id}/token']);
    const op = spec.paths['/api/msp/tenants/{id}/token'].post;
    assert.equal(op.parameters[0].name, 'id');
    assert.ok(op.responses[403], 'admin-only routes document 403');
});

test('the spec documents the public API (/api/v1), which is a separate router the introspection cannot see', () => {
    const app = express();
    const v1 = express.Router();
    v1.post('/remote-access/launch', (req, res) => res.end());
    app.use('/api/v1', v1);
    const spec = buildOpenApiSpec(app);
    const op = spec.paths['/api/v1/remote-access/launch'].post;
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
    const body = op.requestBody.content['application/json'].schema;
    assert.deepEqual(body.required, ['protocol', 'address', 'port']);
    assert.equal(body.properties.createResource.type, 'boolean');
    assert.ok(op.responses[201].content['application/json'].schema.properties.resource);
    assert.ok(op.responses[403].content['application/json'].schema.properties.resourceCreated);
    assert.equal(spec.tags[0].name, op.tags[0], 'the public API comes first');
});
