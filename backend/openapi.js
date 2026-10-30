// Builds an OpenAPI 3 spec by INTROSPECTING the live Express router at runtime, so the docs
// can never drift from the code. Admin-only routes are detected automatically (the
// `requireAdmin` middleware is present in the route's handler stack). The META map below only
// adds human summaries; any route without one still appears (summary = "METHOD /path").

// Friendlier tag (sidebar group) per first path segment.
const TAG_BY_SEGMENT = {
    me: 'Auth', health: 'Meta', docs: 'Meta', webhook: 'Webhook',
    'app-config': 'Settings', integrations: 'Settings',
    'access-profiles': 'Access Profiles', 'posture-checks': 'Posture Checks',
    'network-default-profiles': 'Networks', 'network-grants': 'Networks', 'ad-groups': 'Networks',
    networks: 'Networks', policies: 'Policies',
    locations: 'Locations', automations: 'Automations', audit: 'Audit',
    logs: 'Logs', 'admin-logs': 'Logs',
    users: 'Users & Groups', groups: 'Users & Groups',
    peers: 'Peers', templates: 'Templates',
    'filter-rules': 'Event Filtering', blocklist: 'Blocklist',
};

// Human summaries keyed by "METHOD /express/path".
const META = {
    'GET /api/health': 'Health check',
    'GET /version.txt': 'Current app version (plain text)',
    'GET /api/me': 'Current viewer - identity + isAdmin. Add ?debug=1 for SSO/admin diagnostics.',
    'POST /api/webhook': 'Ingest a NetBird activity event (optional Bearer auth)',

    'GET /api/app-config': 'Get app display config (name, timezone, date format)',
    'PUT /api/app-config': 'Update app display config',
    'GET /api/integrations/netbird': 'NetBird API connection status (token is write-only)',
    'PUT /api/integrations/netbird': 'Set the NetBird Management API URL + token',
    'GET /api/integrations/webhook': 'Webhook endpoint + auth status (token is write-only)',
    'PUT /api/integrations/webhook': 'Set or clear the incoming-webhook Bearer token',

    'GET /api/access-profiles': 'List access profiles (shared groups + direct presets)',
    'POST /api/access-profiles': 'Create an access profile',
    'PUT /api/access-profiles/:id': 'Update an access profile',
    'DELETE /api/access-profiles/:id': 'Delete an access profile',
    'GET /api/network-default-profiles': 'Default access profiles per network',
    'PUT /api/networks/:id/default-profiles': "Set a network's default access profiles",

    'GET /api/posture-checks': 'List posture checks',
    'POST /api/posture-checks': 'Create a posture check',
    'PUT /api/posture-checks/:id': 'Update a posture check',
    'DELETE /api/posture-checks/:id': 'Delete a posture check',
    'GET /api/locations/countries': 'List countries (for geo posture checks)',
    'GET /api/locations/countries/:code/cities': 'List cities in a country',

    'GET /api/automations': 'List automations',
    'POST /api/automations': 'Create an automation',
    'PUT /api/automations/:id': 'Update an automation',
    'DELETE /api/automations/:id': 'Delete an automation',
    'POST /api/automations/:id/run': 'Run an automation now (Sync now)',
    'POST /api/automations/:id/test': "Test a saved automation's source + field mapping (no writes)",
    'POST /api/automations/test': 'Test an unsaved automation config',
    'GET /api/automations/:id/runs': 'Recent run history',
    'GET /api/automations/:id/managed': 'Resources this automation manages',
    'POST /api/automations/:id/repair': 'Drop tracking for resources that no longer exist',
    'POST /api/automations/:id/forget': 'Stop tracking all managed resources',

    'GET /api/audit': 'App audit log (admin actions taken through this app)',
    'GET /api/logs': 'Query activity / event logs',
    'GET /api/logs/users': 'Distinct users in the logs (filter options)',
    'GET /api/logs/sources': 'Distinct sources in the logs',
    'GET /api/logs/stats': 'Aggregate log statistics',
    'GET /api/admin-logs': 'Query admin (management) event logs',
    'GET /api/admin-logs/stats': 'Aggregate admin-log statistics',
    'GET /api/ip-history': 'IP-assignment history - who held a NetBird IP at a given time (q / at / user / sort / dir)',
    'GET /api/ip-history/users': 'Distinct users in the IP history (for the page filter)',
    'GET /api/stats/hourly': 'Events-per-hour counts for the dashboard chart',
    'GET /api/logs/summary': 'Traffic summary - events aggregated per source→destination pair',
    'GET /api/reverse-proxy-status': 'Reverse-proxy (Cloud ingress) clusters + services status',
    'POST /api/reverse-proxy-status/refresh': 'Bust the status cache and pull the current state now',
    'GET /api/reverse-proxy-logs': 'Reverse-proxy access logs (host/path per request), name-enriched',
    'GET /api/reverse-proxy-logs/users': 'Distinct users seen in the stored proxy access logs',
    'GET /api/reverse-proxy-logs/summary': 'Proxy access logs aggregated per service + user',
    'GET /api/reverse-proxy-logs/service-stats': 'Per-service totals over the stored proxy-log history',
    'POST /api/reverse-proxy-logs/sync': 'Pull new access logs from NetBird immediately',
    'GET /api/reverse-proxy-domains': 'Custom domains available for new proxy services',
    'GET /api/reverse-proxy-target-options': 'Flat peers + resources inventory for the target picker',
    'POST /api/reverse-proxy-services': 'Create a reverse-proxy service',
    'GET /api/reverse-proxy-services/:id': 'One reverse-proxy service (auth secrets stripped)',
    'PUT /api/reverse-proxy-services/:id': 'Update a reverse-proxy service (name/enabled/targets/auth/access)',
    'DELETE /api/reverse-proxy-services/:id': 'Delete a reverse-proxy service',
    'POST /api/reverse-proxy-services/expose-docker': 'Expose a Docker container (routing peer + domain resource + service, with rollback)',
    'GET /api/traffic-pull': "The current account's Traffic Events API pull - opt-in flag + last-run status (admin)",
    'PUT /api/traffic-pull': 'Enable or disable polling NetBird for traffic events; enabling kicks one immediate pull (admin)',
    'GET /api/feature-permissions': 'Get fine-grained feature permission grants',
    'PUT /api/feature-permissions': 'Set fine-grained feature permission grants',

    'GET /api/users': 'List NetBird users',
    'GET /api/users/:id': 'User detail (self or admin)',
    'GET /api/groups': 'List groups with usage counts',
    'GET /api/groups/:id': 'Group detail',
    'DELETE /api/groups/:id': "Delete a group (the 'All' group and in-use groups are protected)",
    'POST /api/groups/bulk-delete': 'Bulk-delete groups',

    'GET /api/system-health': 'System health - scheduler status, DB sizes, integrations, retention (admin)',
    'POST /api/automations/:id/dry-run': 'Preview exactly what a sync would do right now - zero writes (admin)',
    'PUT /api/peers/:id/meta': 'Set a device’s operational tags + note (app-side; admin)',
    'POST /api/peers/bulk-tags': 'Bulk-add tags to many devices (merge; notes untouched; admin)',
    'GET /api/peer-tags': 'Distinct device tags in use (fleet viewers only)',
    'GET /api/recertification': 'Access review state - open round with its items + last completed summary (admin)',
    'POST /api/recertification/start': 'Open an access review round now (admin)',
    'POST /api/recertification/cancel': 'Cancel the open review round - already-made decisions stay applied (admin)',
    'GET /api/recertification/rounds': 'Completed review rounds history (admin)',
    'GET /api/recertification/rounds/:id': 'One round’s full report - who kept/revoked what and when (admin)',
    'POST /api/recertification/items/:id/:decision': 'Keep or revoke one review item (admin; revoke performs the removal)',
    'GET /api/settings-export': 'Download a settings backup (config only - secrets are excluded)',
    'POST /api/settings-import': 'Restore a settings backup (secrets are never imported)',
    'GET /api/security-config': 'Security & alerts settings - session limits, request escalation, review digest, anomaly alerts, event retention',
    'PUT /api/security-config': 'Update the security & alerts settings',
    'GET /api/edr-auto-bypass': "The current account's automatic EDR bypass rules (per OS)",
    'PUT /api/edr-auto-bypass': 'Update the automatic EDR bypass rules (per OS; off by default)',

    'GET /api/recurring-access': 'List recurring access rules (weekday + daily-window schedules)',
    'POST /api/recurring-access': 'Create a recurring access rule',
    'PUT /api/recurring-access/:id': 'Update a recurring access rule (disabling revokes an active window)',
    'DELETE /api/recurring-access/:id': 'Delete a recurring access rule',

    'GET /api/peers': 'List peers - user-devices / servers, with compliance flags',
    'GET /api/peers/:id': 'Peer detail',
    'DELETE /api/peers/:id': 'Delete a peer',
    'POST /api/peers/bulk-delete': 'Bulk-delete peers',
    'POST /api/peers/:id/revoke-bypass': 'Remove a compliance (EDR) bypass - admin, or the device owner',

    'GET /api/networks': 'List networks (with canEdit / canView per viewer)',
    'POST /api/networks': 'Create a network',
    'PUT /api/networks/:id': 'Update a network - name/description, and allowDuplicates (per-network opt-out of the duplicate-address guard)',
    'DELETE /api/networks/:id': 'Delete a network (cascades its resources + routers)',
    'GET /api/networks/:id/detail': 'Full network detail - resources, routers, policies',
    'GET /api/networks/:id/policy-options': 'Source-group options for the resource policy editor',
    'POST /api/networks/:id/resources': 'Add a resource to a network',
    'PUT /api/networks/:id/resources/:rid': 'Edit a resource',
    'POST /api/networks/:id/resources/:rid/enabled': 'Enable / disable a resource (kept configured, unreachable while disabled)',
    'DELETE /api/networks/:id/resources/:rid': 'Delete a resource (cleans up its policy + group)',
    'POST /api/networks/:id/resources/bulk-delete': 'Bulk-delete resources',
    'POST /api/networks/:id/resources/merge': 'Merge duplicate resources (same address) into one',
    'POST /api/networks/:id/resources/move': 'Move resources to another network (policies follow)',
    'GET /api/resource-conflicts': 'Same-address resources whose audiences overlap (unpredictable access)',
    'GET /api/billing-summary': 'Billed-users count from the latest NetBird billing event',
    'POST /api/networks/:id/routers': 'Add a routing peer (router) to a network',
    'DELETE /api/networks/:id/routers/:rid': 'Delete a routing peer',
    'PUT /api/networks/:id/grants': 'Set a network’s edit / view grants',
    'GET /api/ad-groups': 'AD groups available for network grants',
    'GET /api/network-grants': 'All network grants',

    'GET /api/policies': 'List access-control policies',
    'POST /api/policies': 'Create a policy',
    'PUT /api/policies/:id': 'Update a policy',
    'GET /api/policies/tidy-names': 'Preview renaming resource policies to the naming template',
    'POST /api/policies/tidy-names': 'Rename the selected policies to the naming template',
    'DELETE /api/policies/:id': 'Delete a policy',

    'GET /api/templates': 'List protocol / port templates',
    'POST /api/templates': 'Create a template',
    'PUT /api/templates/:id': 'Update a template',
    'DELETE /api/templates/:id': 'Delete a template',

    'GET /api/filter-rules': 'List event-filtering rules',
    'POST /api/filter-rules': 'Create a filter rule',
    'PUT /api/filter-rules/:id': 'Update a filter rule',
    'DELETE /api/filter-rules/:id': 'Delete a filter rule',
    'PUT /api/filter-rules/settings/builtin-noise': 'Toggle built-in noise filtering',

    'GET /api/blocklist': 'List address blocklist entries',
    'POST /api/blocklist': 'Add a blocklist entry',
    'POST /api/blocklist/bulk': 'Add multiple blocklist entries at once (duplicates skipped)',
    'PUT /api/blocklist/:id': 'Update a blocklist entry',
    'DELETE /api/blocklist/:id': 'Delete a blocklist entry',
    'GET /api/blocklist/matching': 'Scan existing resources matching an enforcing blocklist entry',
    'POST /api/blocklist/enforce': 'Disable/delete existing resources that match the blocklist',

    'GET /api/temporary-access': 'List temporary access grants',
    'POST /api/temporary-access': 'Grant a user time-boxed access to resources',
    'PUT /api/temporary-access/:id': 'Extend / renew an active grant',
    'POST /api/temporary-access/:id/revoke': 'Revoke an active grant now',
    'DELETE /api/temporary-access/:id': 'Delete a finished grant from history',

    'POST /api/integrations/telegram/webhook': 'Register the Telegram callback webhook',
    'POST /api/integrations/telegram/callback': 'Telegram inline-button callback receiver (public, secret-gated)',
    'GET /api/integrations/smtp': 'Get SMTP email settings (password never returned)',
    'PUT /api/integrations/smtp': 'Update SMTP email settings',
    'POST /api/integrations/smtp/test': 'Send a test email with the current settings',
    'GET /api/approver-config': 'Get who may approve access requests (Entra groups + Telegram)',
    'PUT /api/approver-config': 'Set who may approve access requests',
    'GET /api/auto-approval-config': 'Get auto-approval rules (trusted groups + per-target self-service)',
    'PUT /api/auto-approval-config': 'Set auto-approval rules',
    'GET /api/request-targets': 'Typeahead search of grantable targets for an access request',
    'POST /api/access-requests': 'Create an access request',
    'GET /api/access-requests/mine': 'List the current user’s own access requests',
    'POST /api/access-requests/:id/cancel': 'Cancel one’s own pending request',
    'GET /api/access-requests': 'List access requests (admin)',
    'GET /api/access-requests/pending-count': 'Count of pending requests (admin)',
    'POST /api/access-requests/:id/approve': 'Approve a request → create a temporary grant (admin)',
    'POST /api/access-requests/:id/deny': 'Deny a request (admin)',
};

function tagFor(p) {
    if (p === '/version.txt') return 'Meta';
    const m = p.match(/^\/api\/([^/]+)/);
    if (!m) return 'Misc';
    return TAG_BY_SEGMENT[m[1]] || (m[1].charAt(0).toUpperCase() + m[1].slice(1));
}

const toOapiPath = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const pathParams = (p) => (p.match(/:([A-Za-z0-9_]+)/g) || []).map((s) => s.slice(1));

function buildOpenApiSpec(app, { version = '' } = {}) {
    const paths = {};
    const tags = new Set();
    const stack = (app.router && app.router.stack) || []; // Express 5 (app._router in Express 4)

    for (const layer of stack) {
        const route = layer.route;
        if (!route || typeof route.path !== 'string') continue;
        const p = route.path;
        // Only document the HTTP API; skip the SPA catch-all and the docs UI itself.
        if (!(p.startsWith('/api/') || p === '/version.txt')) continue;
        if (p.startsWith('/api/docs')) continue;

        const adminOnly = (route.stack || []).some((s) => s.handle && s.handle.name === 'requireAdmin');
        const oapiPath = toOapiPath(p);
        const params = pathParams(p).map((name) => ({
            name, in: 'path', required: true, schema: { type: 'string' },
            description: name === 'id' ? 'Resource id' : name === 'rid' ? 'Resource id within the network' : name === 'code' ? 'ISO country code' : name,
        }));

        for (const method of Object.keys(route.methods)) {
            if (method === '_all') continue;
            const tag = tagFor(p);
            tags.add(tag);
            const op = {
                tags: [tag],
                summary: META[`${method.toUpperCase()} ${p}`] || `${method.toUpperCase()} ${oapiPath}`,
                responses: {
                    200: { description: 'OK' },
                    401: { description: 'Not authenticated (when SSO is enabled)' },
                    ...(adminOnly ? { 403: { description: 'Forbidden - admin required' } } : {}),
                },
            };
            if (adminOnly) op.description = '🔒 **Admin only.**';
            if (params.length) op.parameters = params;
            if (method === 'post' || method === 'put') {
                op.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
            }
            paths[oapiPath] = paths[oapiPath] || {};
            paths[oapiPath][method] = op;
        }
    }

    return {
        openapi: '3.0.3',
        info: {
            title: 'NetBird Control API',
            version: version || '0.0.0',
            description: [
                'HTTP API for the NetBird Control companion app.',
                '',
                '**Auth:** when SSO is enabled, every endpoint requires a logged-in session (the `appSession` cookie set by Azure AD / OIDC login). Endpoints marked 🔒 **Admin only** additionally require admin (NetBird owner/admin role, or membership in `ADMIN_GROUP_ID`). With SSO disabled the app is fully open.',
                '',
                'Since this UI runs on the same origin, **Try it out** reuses your current session automatically.',
            ].join('\n'),
        },
        servers: [{ url: '/', description: 'This server' }],
        tags: [...tags].sort().map((name) => ({ name })),
        components: {
            securitySchemes: {
                cookieAuth: { type: 'apiKey', in: 'cookie', name: 'appSession', description: 'Session cookie set by SSO login (express-openid-connect).' },
            },
        },
        paths,
    };
}

module.exports = { buildOpenApiSpec };
