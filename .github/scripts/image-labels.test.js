const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = __dirname;

function repo(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-labels-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.autocrlf', 'false');
    fs.mkdirSync(path.join(dir, '.github', 'scripts'), { recursive: true });
    for (const f of ['image-labels.sh', 'changelog.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, '.github', 'scripts', f));
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
    const release = (version, markers, { tag = true } = {}) => {
        fs.writeFileSync(path.join(dir, 'VERSION'), version);
        fs.writeFileSync(path.join(dir, 'ROLLOUT_BREAKS'), markers.map((m) => `${m}\n`).join(''));
        git('add', '-A');
        git('commit', '-q', '-m', `v${version}`);
        if (tag) git('tag', '-a', `v${version}`, '-m', `v${version}`);
    };
    const labels = (cwd = dir) => {
        const r = spawnSync('bash', [path.join(cwd, '.github', 'scripts', 'image-labels.sh')], { cwd, encoding: 'utf8' });
        if (r.status !== 0) return { error: r.stderr.trim() };
        return { rolloutFrom: /rollout-from=(.*)/.exec(r.stdout)[1].trim() };
    };
    return { dir, git, release, labels };
}

test('a marker that no release has shipped yet gives the version being published', (t) => {
    const { release, labels } = repo(t);
    release('1.0.0', ['base']);
    release('1.1.0', ['base', 'safe'], { tag: false });
    assert.deepEqual(labels(), { rolloutFrom: '1.1.0' });
});

test('rollout-from is the newest first appearance of any marker, whatever the line order', (t) => {
    const { release, labels } = repo(t);
    release('1.0.0', ['a']);
    release('1.1.0', ['a']);
    release('1.2.0', ['b', 'a']);
    release('1.3.0', ['b', 'a'], { tag: false });
    assert.deepEqual(labels(), { rolloutFrom: '1.2.0' });
});

test('a tag outside the history of HEAD is not counted', (t) => {
    const { git, release, labels } = repo(t);
    release('1.0.0', ['a']);
    git('checkout', '-q', '-b', 'side');
    release('9.0.0', ['a', 'b']);
    git('checkout', '-q', 'main');
    release('1.1.0', ['a', 'b'], { tag: false });
    assert.deepEqual(labels(), { rolloutFrom: '1.1.0' });
});

test('a marker that a release shipped can never be removed', (t) => {
    const { release, labels } = repo(t);
    release('1.0.0', ['a', 'b']);
    release('1.1.0', ['a'], { tag: false });
    assert.match(labels().error, /lost the marker "b"/);
});

test('a marker that an older release shipped stays required after a newer release lost it', (t) => {
    const { release, labels } = repo(t);
    release('1.0.0', ['a', 'b']);
    release('1.1.0', ['a']);
    release('1.2.0', ['a'], { tag: false });
    assert.match(labels().error, /lost the marker "b" that v1\.0\.0 shipped/);
});

test('a marker listed twice is refused', (t) => {
    const { release, labels } = repo(t);
    release('1.0.0', ['a', 'a'], { tag: false });
    assert.match(labels().error, /twice/);
});

test('a shallow clone is refused instead of guessing from missing tags', (t) => {
    const { dir, release, labels } = repo(t);
    release('1.0.0', ['a']);
    release('1.1.0', ['a'], { tag: false });
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'image-labels-shallow-'));
    t.after(() => fs.rmSync(shallow, { recursive: true, force: true }));
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir.replace(/\\/g, '/')}`, shallow]);
    assert.match(labels(shallow).error, /full history/);
});
