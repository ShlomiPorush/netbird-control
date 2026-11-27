const { pool } = require('./core');

let readVersion = async () => {
    const r = await pool.query(`SELECT value FROM coordination WHERE key = 'settings_version'`);
    return r.rows[0] ? r.rows[0].value : null;
};

module.exports = {
    readSettingsVersion: () => readVersion(),
    _setSettingsVersionReaderForTest(fn) { readVersion = fn; },
};
