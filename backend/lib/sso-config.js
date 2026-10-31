// SSO is all or nothing. Setting any OIDC_* variable means login is wanted, so the other two and
// BASE_URL must be set as well. BASE_URL alone is not SSO: it also serves the webhook setup and
// notification links without login.
const OIDC_VARS = ['OIDC_ISSUER_BASE_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'];

// The SSO variables still missing when SSO is only partly configured; [] when it is off or complete.
function missingSsoSettings(env) {
    if (!OIDC_VARS.some((k) => env[k])) return [];
    return [...OIDC_VARS, 'BASE_URL'].filter((k) => !env[k]);
}

module.exports = { missingSsoSettings };
