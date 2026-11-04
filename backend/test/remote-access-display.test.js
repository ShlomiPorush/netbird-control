// How sessions look: the administrator's RDP display and SSH terminal settings reach guacd as
// connection parameters, with sensible defaults and only values guacd 1.6 accepts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ra = require('../lib/remote-access');
const { connectArgs, normConfig, setConfigForTest } = ra._internal;

const RDP_NAMES = ['color-depth', 'disable-gfx', 'server-layout', 'enable-font-smoothing', 'enable-wallpaper', 'enable-theming',
    'enable-full-window-drag', 'enable-desktop-composition', 'enable-menu-animations'];
const rdpSession = { protocol: 'rdp', gateway: 'ip', address: '10.0.0.5', port: 3389, creds: {}, timezone: '' };
const sshSession = { protocol: 'ssh', gateway: 'ip', address: '10.0.0.5', port: 22, creds: {}, timezone: '' };

test('defaults: full color, ClearType on, desktop effects off, US layout, SSH 12pt gray on black', () => {
    setConfigForTest({});
    assert.deepEqual(connectArgs(rdpSession, RDP_NAMES), ['32', '', 'en-us-qwerty', 'true', '', '', '', '', '']);
    assert.deepEqual(connectArgs(sshSession, ['font-size', 'color-scheme']), ['12', 'gray-black']);
});

test('the saved settings are what guacd gets', () => {
    setConfigForTest({
        rdp: { colorDepth: 16, serverLayout: 'de-de-qwertz', fontSmoothing: false, wallpaper: true, theming: true, fullWindowDrag: true, desktopComposition: true, menuAnimations: true },
        ssh: { fontSize: 16, colorScheme: 'white-black' },
    });
    // Below 32-bit the graphics pipeline is off, or guacd would ignore the depth.
    assert.deepEqual(connectArgs(rdpSession, RDP_NAMES), ['16', 'true', 'de-de-qwertz', '', 'true', 'true', 'true', 'true', 'true']);
    assert.deepEqual(connectArgs(sshSession, ['font-size', 'color-scheme']), ['16', 'white-black']);
    setConfigForTest({});
});

test('values guacd does not know fall back to the defaults', () => {
    const c = normConfig({ rdp: { colorDepth: 15, serverLayout: 'he-il-qwerty', wallpaper: 'yes' }, ssh: { fontSize: 99, colorScheme: 'solarized' } });
    assert.equal(c.rdp.colorDepth, 32);
    assert.equal(c.rdp.serverLayout, 'en-us-qwerty');
    assert.equal(c.rdp.wallpaper, true);
    assert.equal(c.rdp.fontSmoothing, true);
    assert.equal(c.ssh.fontSize, 32);
    assert.equal(c.ssh.colorScheme, 'gray-black');
});

test('the settings page gets the choices guacd offers', () => {
    setConfigForTest({});
    const o = ra.getRemoteAccessConfig().options;
    assert.ok(o.rdpLayouts.includes('en-us-qwerty') && o.rdpLayouts.includes('failsafe'));
    assert.deepEqual(o.rdpColorDepths, [8, 16, 24, 32]);
    assert.ok(o.sshColorSchemes.includes('gray-black'));
});
