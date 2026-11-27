# Releases and Deployment

How NetBird Control releases are published, what the image tells a deployment tool, why two instances of the app can run
together during an update, and what a host needs to update the app with a zero-downtime rollout with
[docker rollout](https://github.com/wowu/docker-rollout). For an update from the command line, see
[Upgrading Without Downtime](../README.md#upgrading-without-downtime) in the README.

## Image Tags

Every release is published as `ghcr.io/shlomiporush/nbcontrol`:

| Tag | What it is |
|---|---|
| `X.Y.Z` | The release. Pushed once and never replaced. |
| `latest` | The highest published release. It moves with every newer release. |

The repository has the git tag `vX.Y.Z` for each release, on the commit the image was built from.

A release is published only by `.github/workflows/release.yml`, when a release pull request made by
`scripts/release.sh` is merged into `main`. The branch protection of `main` requires the checks `release-check`,
`backend-tests`, `frontend-build` and `docker-build`, requires the branch to be up to date, and applies to admins too.
So the merged commit is the tested one, and the image is built from it after those checks passed. The workflow has no
manual trigger. A re-run of a failed run never builds `X.Y.Z` again when it exists. When a published release's image was
deleted, the run stops and asks you to restore the deleted package version, so the tag never points to another image.

## Image Labels

| Label | Value | Used by |
|---|---|---|
| `netbird-control.zero-downtime-update` | `1` | `scripts/update.sh`: the image can run beside another instance of itself. |
| `netbird-control.compose-sha256` | sha256 of the repository's `docker-compose.yml` at the release commit | A rollout tool: a release whose value differs from the running image's changed the example Compose file, so it is updated by hand. |
| `netbird-control.rollout-from` | The oldest running release this image may run beside | A rollout tool and `scripts/update.sh`: a running release older than this is updated by hand. |

`.github/scripts/image-labels.sh` computes the last two for the release workflow and for the `docker-build` check, which
builds the image on every pull request and checks that both labels and the health check are on it.

### How `rollout-from` Is Decided

The file `ROLLOUT_BREAKS` in the repository root lists every change that a running release cannot run beside, one marker
per line. `rollout-from` is the newest of the releases that first shipped each marker. A marker that no release has shipped
yet counts as the release being published. Nobody edits a version by hand:

- A database migration that is not overlap-safe must have the line `migration-<id>`; a test fails without it.
- Any other change that a running release cannot run beside, such as a change to the leader lock, the drain or a request
  the other release's frontend or backend sends, gets a short marker of its own in the same pull request.
- A marker is never removed; the label script fails when a marker that a release shipped is gone.

The release that first contains these two-instance changes is marked `two-instances-safe`, so it labels itself as its own
`rollout-from`: it is deployed by hand, once, and the releases after it roll out without downtime until a new marker
appears. Images up to 1.9.1 carry neither `compose-sha256` nor `rollout-from`.

## Health Check

The image has a health check: `node healthcheck.js` asks `GET /api/health` inside the container. The app answers only after
it has prepared the database and opened its port, so a new container is healthy only when it serves. While the old
container drains before it stops, `/api/health` answers 503. A start that cannot reach the database or finish its
migrations keeps trying for 240 seconds before it gives up, so a rollout sees an unhealthy container, not one that exits.

## Database Changes

The tables a release had until 1.9.1 are a frozen baseline that runs once. Every later change is a numbered migration in
`backend/lib/migrations.js`, recorded in `schema_migrations`, so a start with nothing to migrate changes nothing in the
database and a new container never locks a table the old one uses.

A migration is overlap-safe when the old release can keep working on the changed database: a new table, or a new column
that is nullable or has a constant default. Overlap-safe migrations are written as data, not SQL, and a test refuses any
other shape. They wait for a table lock at most 200 ms at a time and try again, so the old container's queries never wait
long behind them. Indexes on existing tables are built after start-up by the leader, concurrently. Anything else (a
rewrite, a dropped or renamed column, a new constraint, a change to what stored values mean) is not overlap-safe and adds
its marker to `ROLLOUT_BREAKS`, which makes that release one that is deployed by hand.

## Two Instances at Once

During a rollout the old and the new container run together for a few seconds to a few minutes against one database. One
of them is the leader: the one that holds a PostgreSQL lock, which the old container keeps until it exits. Both serve
requests. What would otherwise go wrong is coordinated through PostgreSQL:

| What | How it stays right |
|---|---|
| Scheduled jobs, start-up recovery, queued notifications, the Telegram webhook | Only the leader runs them. Each step checks that it still leads, and a stop waits for running work before it releases the lead. |
| Changes to one NetBird user, rule, grant, automation, access request or device bypass | One PostgreSQL lock per object, across instances. |
| A user block, unblock or delete | It closes the user's access in the app before NetBird is asked and keeps it closed until NetBird shows the change. A refresh of the user list never writes an older state over it. |
| The users and devices copies of NetBird | A refresh reads NetBird and writes its copy under one lock per account, in one transaction. |
| Device change notifications | Queued in the same transaction as the change and sent by the leader, so each is sent once. |
| An automatic EDR bypass and its revoke | Recorded before NetBird is asked; a lost answer never makes the app forget a bypass or a revoke. |
| An access request approval | Recorded as being approved first, so a deny on the other instance cannot decide it too; the leader finishes one that a stopped instance left behind. |
| Settings | A change on one instance is in effect on the other from its next request. A restore applies all of its settings and tables or none. |
| The sign-in idle timeout | The last activity is kept in the session itself, so both instances see it. |
| A page that the old release served | It reloads once into the new release when it needs a file only the old release had. |

What users can notice:

- Browser remote access sessions (RDP and SSH) that run on the old container end; users open them again.
- New remote access sessions wait at least 90 seconds after the new container starts, and then until the app has synced the
  target groups again (see [Browser Remote Access](remote-access.md)).
- A tab that was open before the update reloads once when it opens a page whose files only the old release had.
- Rate limits and recent sign-in activity are counted per container.
- Signing out clears the session in that browser. A copy of the session cookie made before the sign-out keeps working
  until the idle or session limit ends it, as it does with one container.
- While a tenant token is replaced, a request that started with the old token can fail once; it works when repeated.
- A Telegram or email notification is sent twice only when the provider accepted it and its answer was lost.

## The Host's Compose File and .env

The repository's `docker-compose.yml` is an example for a first install. It uses `TAG`, `container_name` and a published
port, so it does not fit a rollout. For a zero-downtime rollout with docker rollout, the host's own files need:

- `name: netbird-control` at the top of `docker-compose.yml`, if the rollout tool expects that project name.
- `image: ghcr.io/shlomiporush/nbcontrol:${VERSION}` on the `app` service, and exactly one `VERSION=X.Y.Z` line in `.env`.
  Do not set `VERSION` in the shell, because it takes precedence over `.env`.
- On the `app` service: no `container_name`, no `ports`, no `build`, no `network_mode: host`, and one replica, because two
  containers run at once and the app is reached only through a reverse proxy.
- `restart: unless-stopped` or `restart: always`.
- `stop_grace_period: 30s`, so a stopping container can finish its running jobs (it waits up to 25 seconds).
- The drain label `docker-rollout.pre-stop-hook=touch /tmp/drain && sleep 5`, and a reverse-proxy health check on
  `/api/health`.
- A sticky-session cookie on the reverse proxy, so a browser stays on one container while both run. With Traefik, add
  `traefik.http.services.nbcontrol.loadbalancer.sticky.cookie=true` to the labels of the README example.
- With SSO, `SESSION_SECRET` set, so both containers accept the same sign-in.
- A direct connection to PostgreSQL, or a pooler in session mode.
- A rollout timeout of at least 300 seconds (`docker rollout --timeout 300`; `scripts/update.sh` uses 300 by default),
  because a start may wait for a busy table during a migration.

The Traefik example in [Upgrading Without Downtime](../README.md#upgrading-without-downtime) shows the rest. Change its
image line to `${VERSION}` and add `name: netbird-control`.

### Moving an Existing Install to the Project Name

Compose names containers, networks and volumes after the project, which is the directory name unless `name:` sets it. If
your install runs under another project name, the move has a short downtime, and the database volume must be kept:

1. Find the volume that holds the database: `docker volume ls`. With the example file it is `<project>_pgdata-netbird`.
2. In `docker-compose.yml`, keep using it under the new project name: under `volumes:`, declare
   `pgdata-netbird: { external: true, name: <project>_pgdata-netbird }`.
3. Remove `COMPOSE_PROJECT_NAME` from `.env` if it is there, because it takes precedence over `name:`.
4. Set `OLD` to the old project name, then stop the old project, check that no container uses the database volume any
   more, and only then start under the new name. `down` without `-v` keeps the volume. If the volume does not exist or is
   still in use, nothing starts:

   ```bash
   OLD=old-project-name
   VOLUME="${OLD}_pgdata-netbird"
   docker volume inspect "$VOLUME" > /dev/null &&
     docker compose -p "$OLD" down &&
     INUSE=$(docker ps -aq --filter "volume=$VOLUME") &&
     [ -z "$INUSE" ] &&
     env -u COMPOSE_PROJECT_NAME docker compose -p netbird-control up -d --wait
   ```

   If the last command fails after the database of the new project has started, the block stops on a second run, because
   that database now uses the volume. Fix the cause, then run only
   `env -u COMPOSE_PROJECT_NAME docker compose -p netbird-control up -d --wait`.

## Updating by Hand

A release that cannot roll out, because its `rollout-from` is newer than the running release or it changed the example
Compose file, is updated with a short downtime. The first release with these two-instance changes is one of them. Run this
in the directory of `docker-compose.yml` and `.env`, with the version you update to. It pulls the image, checks that
Compose resolves the `app` service to it, and only then changes `.env` and replaces the container. If a step fails, the
following ones do not run:

```bash
NEW=X.Y.Z
IMAGE=ghcr.io/shlomiporush/nbcontrol
docker pull "$IMAGE:$NEW" &&
  [ "$(VERSION="$NEW" docker compose config --images app)" = "$IMAGE:$NEW" ] &&
  sed -i "s/^VERSION=.*/VERSION=$NEW/" .env &&
  env -u VERSION docker compose up -d --no-deps --wait --wait-timeout 300 app
```

To go back, run the same commands with the version that ran before, but only when the release notes do not say that the
database changed in a way the older version cannot use.

`scripts/update.sh` reads `netbird-control.rollout-from` too, and updates with this short downtime by itself when the
running release is older or the new image does not have the label.

If an update leaves the `app` service without a running container, run the commands above with the version you were
updating to. `.env` already names it, so the check and the start bring that version up.
