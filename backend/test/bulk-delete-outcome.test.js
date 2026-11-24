// The network page's bulk delete answers 200 with only the ids it couldn't delete and NetBird's
// reasons, so the page names those resources from the selection it sent
// (frontend/src/lib/bulkDelete.ts, read here through Node's type stripping).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'bulkDelete.ts')).href);
const sent = [{ id: 'r1', name: 'Web' }, { id: 'r2', name: 'DB' }, { id: 'r3', name: '' }];

test('the message names the failed resources from the sent selection, with the reasons', async () => {
    const { bulkDeleteMessage } = await load();
    assert.equal(bulkDeleteMessage(sent, [{ id: 'r1', error: 'refused' }]), "1 resource couldn't be deleted: Web: refused");
    assert.equal(bulkDeleteMessage(sent, [{ id: 'r2', error: 'used by a policy' }, { id: 'r3', error: 'timeout' }]),
        "2 resources couldn't be deleted: DB: used by a policy; r3: timeout", 'a resource without a name is shown by its id');
    assert.equal(bulkDeleteMessage(sent, [{ id: 'r9', error: 'refused' }]), "1 resource couldn't be deleted: r9: refused");
});

test('no failures: there is no message', async () => {
    const { bulkDeleteMessage } = await load();
    assert.equal(bulkDeleteMessage(sent, []), '');
});
