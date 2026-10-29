// Container healthcheck (used by the Dockerfile HEALTHCHECK). Exits 0 when the server
// answers GET /api/health with 200, otherwise 1 - so Docker/compose can mark the app
// container healthy/unhealthy. Dependency-free (Node core http only) and honours PORT,
// so it works even when the app listens on a non-default port. Liveness only: it does
// not probe the DB (a DB blip shouldn't restart the app - it reconnects on its own).
const http = require('http');

const port = process.env.PORT || 3000;
// nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server -- loopback-only liveness probe inside the container (127.0.0.1); no data leaves the host and TLS terminates at the reverse proxy, not here.
const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 4000 }, (res) => {
    res.resume(); // drain the response so the socket can close
    process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
