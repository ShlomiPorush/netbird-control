// The database password has no default: the server refuses to start without one, or with the
// example value that older versions of .env.example shipped (it is public, so it protects nothing).
// The value is compared exactly and passed to pg unchanged.
const DB_PASSWORD_PLACEHOLDER = 'change-me-to-a-strong-password';

// Why DB_PASSWORD can't be used, or null when it can. The message never includes the value.
function dbPasswordProblem(env) {
    const pw = env.DB_PASSWORD;
    if (pw === undefined || pw === '') {
        return 'DB_PASSWORD is not set. Set it in .env to the PostgreSQL password of DB_USER '
            + '(for a new install, generate one with `openssl rand -hex 32`).';
    }
    if (pw === DB_PASSWORD_PLACEHOLDER) {
        return `DB_PASSWORD is still the example value ${DB_PASSWORD_PLACEHOLDER}, which is public. `
            + 'Change the password of DB_USER in PostgreSQL, put the new one in .env, and restart '
            + '(see Upgrading in README).';
    }
    return null;
}

module.exports = { DB_PASSWORD_PLACEHOLDER, dbPasswordProblem };
