#!/usr/bin/env bash
#
# update.sh - update a NetBird Control deployment, without downtime where the deployment allows it.
#
#   ./update.sh 1.4.0    pull 1.4.0, update the app and set its tag in .env
#   ./update.sh          pull and update the tag already set in .env

# ─── Settings ─────────────────────────────────────────────────────────────────────────────────
# Change them here, or set one for a single run: TAG_VARIABLE=MY_TAG ./update.sh 1.4.0

# The .env variable that sets the image tag. Empty: TAG or VERSION, whichever the Compose file uses.
TAG_VARIABLE="${TAG_VARIABLE:-}"
# The services to update, separated by spaces. Empty: every NetBird Control service of the project.
SERVICES="${SERVICES:-}"
# Seconds a new container has to become healthy.
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-180}"
# Seconds between "the new container is healthy" and draining the old one, so the reverse proxy
# sends requests to the new one first (Traefik applies Docker changes after a short delay).
SETTLE_SECONDS="${SETTLE_SECONDS:-10}"
# ──────────────────────────────────────────────────────────────────────────────────────────────

# Copy it beside the deployment's docker-compose.yml and .env and run it from there. It finds the
# services to update by themselves, not by name or image: every service of the Compose project
# (COMPOSE_FILE and COMPOSE_PROFILES in .env are honoured) whose image carries the label
# netbird-control.zero-downtime-update. Other services (a database, gateways, a proxy) are listed
# and left alone. A service labelled netbird-control.rollout: "false" in the Compose file is left
# alone too.
#
# A service is updated with docker rollout (github.com/wowu/docker-rollout, exactly v0.14): the new
# container starts beside the old one, which is drained and removed only once the new one is
# healthy; a new one that does not get healthy is removed and the old one keeps serving. That
# needs a deployment behind a reverse proxy (README, "Upgrading Without Downtime"):
#   - no container_name and no published ports (two containers run at once),
#   - restart: unless-stopped or always (a new container that crashes at once stays visible to
#     docker rollout, which then rolls back),
#   - a health check, the label docker-rollout.pre-stop-hook and, behind Traefik, a Traefik service
#     health check on /api/health, so the proxy stops sending requests to the old container first,
#   - with SSO, the same SESSION_SECRET in the old container and in .env.
# When one of these is missing, or the running version is older than the first that can run beside
# another instance, the service is recreated instead (docker compose up -d), with a short downtime,
# and the script says why before it acts.
#
# .env changes right before the first service is updated, and only its tag line (see TAG_VARIABLE
# above). When no container of that service ends up on the new image, the line goes back to what
# it was. Needs flock (util-linux). The output never shows the resolved Compose configuration,
# which holds secrets.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

ROLLOUT_VERSION="v0.14"
ZERO_DOWNTIME_LABEL="netbird-control.zero-downtime-update"
OPT_OUT_LABEL="netbird-control.rollout"
DRAIN_LABEL="docker-rollout.pre-stop-hook"

log() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

for name in ROLLOUT_TIMEOUT SETTLE_SECONDS; do
  if [[ ! ${!name} =~ ^[0-9]+$ ]]; then
    err "$name must be a number of seconds, not '${!name}'."
    exit 1
  fi
done

# The resolved Compose configuration as "service<TAB>key<TAB>value" lines, for the few keys this
# script reads. Arguments go in front of docker compose (env TAG=... or VERSION=... to resolve
# another release).
# The OIDC values (one is a secret) stay in this pipe and in variables; never print them.
service_facts() {
  "$@" docker compose config | awk '
    function unq(s) { gsub(/^["\047]|["\047]$/, "", s); return s }
    function rest(s) { if (index(s, ": ")) { sub(/^[^:]*: /, "", s); return unq(s) } return "" }
    /^services:/ { in_services = 1; next }
    in_services && /^[^ ]/ { in_services = 0 }
    !in_services { next }
    /^  [^ ]/ { service = $1; sub(/:$/, "", service); service = unq(service); block = ""; sub6 = ""; next }
    /^    [^ ]/ {
      line = $0; sub(/^    /, "", line)
      key = line; sub(/:.*/, "", key); block = key; sub6 = ""
      value = rest(line)
      if (key == "image" || key == "container_name" || key == "network_mode" || key == "restart") print service "\t" key "\t" value
      else if (key == "ports" && value != "[]") print service "\tports\t1"
      else if (key == "healthcheck") print service "\thealthcheck\t1"
      next
    }
    /^      [^ ]/ {
      line = $0; sub(/^      /, "", line)
      key = line; sub(/:( .*)?$/, "", key); key = unq(key); sub6 = key; first_item = 1
      if (block == "labels") print service "\tlabel:" key "\t" rest(line)
      else if (block == "depends_on") print service "\tdepends_on\t" key
      else if (block == "healthcheck" && line ~ /^disable: true/) print service "\thealthcheck_disable\t1"
      else if (block == "environment" && key ~ /^(OIDC_ISSUER_BASE_URL|OIDC_CLIENT_ID|OIDC_CLIENT_SECRET)$/) print service "\tenv:" key "\t" rest(line)
      next
    }
    # test: ["NONE"] turns the health check off, like disable: true.
    /^        - / && block == "healthcheck" && sub6 == "test" {
      if (first_item) { item = $0; sub(/^        - /, "", item); if (unq(item) == "NONE") print service "\thealthcheck_disable\t1" }
      first_item = 0
      next
    }
    # A dependency that only has to have run once, or that may be missing, need not be running.
    /^        [^ ]/ && block == "depends_on" {
      line = $0; sub(/^        /, "", line)
      if (line ~ /^condition: service_completed_successfully$/ || line ~ /^required: false$/) print service "\tdep_optional\t" sub6
    }
  '
}

# The value of one fact of one service, or nothing.
fact() { awk -F '\t' -v s="$1" -v k="$2" '$1 == s && $2 == k { print $3; exit }' <<<"$facts"; }
facts_of() { awk -F '\t' -v s="$1" -v k="$2" '$1 == s && $2 == k { print $3 }' <<<"$facts"; }

# SESSION_SECRET compared as JSON strings, which keep every character, on one line each, and are
# never decoded or printed. The new value as Compose resolves it (it escapes <, > and & as \u003c,
# \u003e and \u0026), or nothing when unset or empty.
new_secret_json() {
  "${new_env[@]}" docker compose config --format json | awk -v s="$1" '
    /^    "[^"]*": \{$/ { service = $0; sub(/^    "/, "", service); sub(/": \{$/, "", service); in_env = 0; next }
    service == s && /^      "environment": \{$/ { in_env = 1; next }
    in_env && /^      \}/ { in_env = 0 }
    # Reads to the end (no exit): an early exit could fail the pipeline on SIGPIPE.
    in_env && !done && index($0, "        \"SESSION_SECRET\": ") == 1 {
      v = substr($0, length("        \"SESSION_SECRET\": ") + 1); sub(/,$/, "", v)
      if (v != "\"\"") print v
      done = 1
    }
  '
}
# The value in a container's environment, as the same JSON string, or nothing.
old_secret_json() {
  docker inspect -f '{{range .Config.Env}}{{json .}}{{println}}{{end}}' "$1" |
    awk '!done && index($0, "\"SESSION_SECRET=") == 1 { v = substr($0, length("\"SESSION_SECRET=") + 1); if (v != "\"") print "\"" v; done = 1 }' |
    sed 's/</\\u003c/g; s/>/\\u003e/g; s/&/\\u0026/g'
}
container_label() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1"; }

# The immutable IDs of the images the running containers of a service use, one per line.
running_image_ids() {
  local ids
  ids="$(docker compose ps -q "$1")" || return 1
  # shellcheck disable=SC2086 # one argument per container id
  [[ -z $ids ]] || docker inspect -f '{{.Image}}' $ids
}

# Every running container of the service uses the new image and none is unhealthy or starting.
on_new_image_and_healthy() {
  local ids id
  ids="$(docker compose ps -q "$1")" || return 1
  [[ -n $ids ]] || return 1
  for id in $ids; do
    [[ $(docker inspect -f '{{.Image}}' "$id") == "${new_id[$1]}" ]] || return 1
    case "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")" in
      healthy | none) ;;
      *) return 1 ;;
    esac
  done
}

# Sets the tag line (TAG or VERSION) of .env, as it is now, to the given value. The new text goes to a private file
# (mktemp, owner only) and then into .env itself, which keeps its owner, mode and symlink target. A
# write cut short leaves that file, with the full text, for the operator.
edited=""
env_tmp=""
env_partial=""
env_value=""
write_tag() {
  env_value="$1"
  env_tmp="$(mktemp .env.update.XXXXXX)" || return 1
  sed "s/^$tag_var=.*/$tag_var=$1/" .env >"$env_tmp" || return 1
  edited=1
  env_partial=1
  cat "$env_tmp" >.env || return 1
  env_partial=""
  rm -f "$env_tmp"
  env_tmp=""
}
cleanup() {
  [[ -n $env_tmp ]] || return 0
  if [[ -n $env_partial ]]; then
    err "Writing .env was cut short. Its full text with $tag_var=$env_value is in $env_tmp: put it in place with: cat $env_tmp > .env && rm $env_tmp"
  else
    rm -f "$env_tmp"
  fi
}
trap cleanup EXIT

compose_file=""
for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  [[ -f $f ]] && compose_file="$f"
done
if [[ ! -f .env || -z $compose_file ]]; then
  err "Run this beside the deployment's Compose file and .env."
  exit 1
fi
if ! command -v flock >/dev/null; then
  err "flock is not installed (it comes with util-linux)."
  exit 1
fi
# One update at a time in this folder. The lock is on the folder, which an editor never replaces.
exec 9<.
if ! flock -n 9; then
  err "Another update.sh is running in this folder. Wait for it to finish."
  exit 1
fi
# Values exported in this shell would win over .env for Compose, so .env would not say what runs.
for name in TAG VERSION COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES; do
  if [[ -n ${!name+set} ]]; then
    err "$name is set in this shell's environment. Unset it (unset $name) and run this again: .env decides it."
    exit 1
  fi
done

rolled=()
rolling=""
previous=""
first=""
expected=""
tag_var="TAG"
# Puts the tag line back when .env was changed and no container of the first service runs the
# new image.
restore() {
  # A signal lands only after cat returns, so a write may be complete though not yet marked so.
  if [[ -n $env_partial ]] && cmp -s "$env_tmp" .env; then
    env_partial=""
  fi
  [[ -n $edited && ${#rolled[@]} -eq 0 && -z $env_partial ]] || return 0
  if write_tag "$previous"; then
    warn "$tag_var is back to $previous in .env."
  else
    err "Could not set $tag_var back to $previous in .env. Set it there by hand."
  fi
}
stop() {
  err "$*"
  restore
  if ((${#rolled[@]} > 0)); then
    warn "On the new image: ${rolled[*]}. Fix the cause and run this again."
  fi
  exit 1
}
# Records a service as updated when a running container of it uses the new image.
record() {
  local images
  images="$(running_image_ids "$1")" || return 1
  if grep -qxF "${new_id[$1]}" <<<"$images"; then
    [[ " ${rolled[*]} " == *" $1 "* ]] || rolled+=("$1")
  fi
}
interrupted() {
  trap - INT TERM
  if [[ -n $rolling ]]; then
    if ! record "$rolling"; then
      # Unknown what runs: leave .env as it is rather than guess.
      rolled+=("$rolling")
      err "Interrupted while updating $rolling, and Docker did not say what runs now. .env has $tag_var=$expected; check with: docker compose ps $rolling"
    else
      err "Interrupted while updating $rolling. Check its containers with: docker compose ps -a $rolling"
    fi
  else
    err "Interrupted."
  fi
  restore
  if ((${#rolled[@]} > 0)); then
    warn "On the new image: ${rolled[*]}."
  fi
  exit 130
}
trap interrupted INT TERM

version="${1:-}"
new_env=(env)
if [[ -n $version ]]; then
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    err "A release looks like 1.4.0, not '$version'."
    exit 1
  fi
  # The .env variable that sets the image tag: the one TAG_VARIABLE names, or else TAG or VERSION.
  # It counts only when it changes the images Compose resolves when it is given a test value.
  sets_a_tag() {
    local images
    images="$(env "$1=0.0.0-update-probe" docker compose config --images 2>/dev/null)" || return 1
    grep -q ':0\.0\.0-update-probe$' <<<"$images"
  }
  tag_var=""
  if [[ -n $TAG_VARIABLE ]]; then
    if [[ ! $TAG_VARIABLE =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      err "TAG_VARIABLE must be the name of a variable in .env, such as VERSION, not '$TAG_VARIABLE'."
      exit 1
    fi
    if [[ -n ${!TAG_VARIABLE+set} ]]; then
      err "$TAG_VARIABLE is set in this shell's environment. Unset it (unset $TAG_VARIABLE) and run this again: .env decides it."
      exit 1
    fi
    if ! sets_a_tag "$TAG_VARIABLE"; then
      err "No image tag in this Compose project comes from $TAG_VARIABLE. Write the image as ghcr.io/shlomiporush/nbcontrol:\${$TAG_VARIABLE}, or set TAG_VARIABLE at the top of update.sh to the variable it uses."
      exit 1
    fi
    tag_var="$TAG_VARIABLE"
  else
    for name in TAG VERSION; do
      sets_a_tag "$name" || continue
      if [[ -n $tag_var ]]; then
        err "Both TAG and VERSION set an image tag in this Compose project. Use one of them."
        exit 1
      fi
      tag_var="$name"
    done
    if [[ -z $tag_var ]]; then
      err "No image tag in this Compose project comes from TAG or VERSION in .env, so this script cannot choose the release. Set TAG_VARIABLE at the top of update.sh to the variable your Compose file uses, or run ./update.sh without a release."
      exit 1
    fi
  fi
  if ! grep -q "^$tag_var=" .env; then
    err ".env has no $tag_var line. Add one with the release that runs now, for example $tag_var=1.3.1, and run this again."
    exit 1
  fi
  # For the checks and the pull only; .env changes right before the first update.
  new_env=(env "$tag_var=$version")
fi

facts="$(service_facts "${new_env[@]}")" || stop "docker compose config failed: see above."
mapfile -t all_services < <(awk -F '\t' '!seen[$1]++ { print $1 }' <<<"$facts")
if [[ -n $SERVICES ]]; then
  read -r -a wanted <<<"$SERVICES"
  for service in "${wanted[@]}"; do
    [[ " ${all_services[*]} " == *" $service "* ]] || stop "$service is not a service of this Compose project."
  done
  candidates=()
  for service in "${all_services[@]}"; do
    [[ " ${wanted[*]} " == *" $service "* ]] && candidates+=("$service")
  done
else
  candidates=("${all_services[@]}")
fi

# Pull every candidate with an image, then keep those whose new image declares the label. Pulling a
# service that is not updated changes nothing that runs.
declare -A image_of=() new_id=()
pullable=()
for service in "${candidates[@]}"; do
  if [[ $(fact "$service" "label:$OPT_OUT_LABEL") == "false" ]]; then
    log "Skipped: $service (labelled $OPT_OUT_LABEL: \"false\")"
    continue
  fi
  image="$(fact "$service" image)"
  if [[ -z $image ]]; then
    log "Skipped: $service (no image to pull)"
    continue
  fi
  image_of[$service]="$image"
  pullable+=("$service")
done
((${#pullable[@]} > 0)) || stop "No service to update."

log "Pulling: ${pullable[*]}"
"${new_env[@]}" docker compose pull "${pullable[@]}" || stop "Pulling failed: nothing was changed."

services=()
too_old=()
for service in "${pullable[@]}"; do
  label="$(docker image inspect -f "{{index .Config.Labels \"$ZERO_DOWNTIME_LABEL\"}}" "${image_of[$service]}" 2>/dev/null)" || label=""
  if [[ $label != "1" ]]; then
    # A NetBird Control release from before this script (1.3.1 and older), or another image.
    img_source="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.source"}}' "${image_of[$service]}" 2>/dev/null)" || img_source=""
    if [[ ${img_source,,} == */netbird-control ]]; then
      warn "$service: not updated. ${image_of[$service]} is a NetBird Control release from before update.sh existed, so this script cannot update to it."
      too_old+=("$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "${image_of[$service]}" 2>/dev/null || true)")
    else
      log "Skipped: $service (not a NetBird Control image)"
    fi
    continue
  fi
  new_id[$service]="$(docker image inspect -f '{{.Id}}' "${image_of[$service]}")" || stop "Could not read the image ID of ${image_of[$service]}."
  services+=("$service")
done
if ((${#services[@]} == 0)); then
  if ((${#too_old[@]} > 0)); then
    warn "Nothing was updated. Run it with a newer release: ./update.sh X.Y.Z (newer than ${too_old[0]:-the one in .env})."
  else
    warn "Nothing was updated: no service in this project runs a NetBird Control image."
  fi
  exit 1
fi
first="${services[0]}"
expected="${image_of[$first]##*:}"

# The release .env holds now, to put back if the first service fails.
if [[ -n $version ]]; then
  previous="$(sed -n "s/^$tag_var=//p" .env | tail -n 1)"
  [[ $previous =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || stop "Could not read the current $tag_var from .env."
fi

# How each service is updated, and why when not without downtime. Read now for the checks and again
# right before acting.
declare -A mode_of=() why_of=()
plan_service() {
  local service="$1" reasons=() deps_down=() running all old restart hc dep labels image_hc
  running="$(docker compose ps -q "$service")" || stop "Could not read the containers of $service from Docker."
  all="$(docker compose ps -aq "$service")" || stop "Could not read the containers of $service from Docker."
  # A dependency that must run has to run. One that need not (it only had to run once, or it is
  # optional) may stay down, but docker rollout would start it (it runs compose up without
  # --no-deps), so then the service is recreated with --no-deps instead.
  for dep in $(facts_of "$service" depends_on); do
    [[ -n $(docker compose ps -q "$dep") ]] && continue
    if [[ " $(facts_of "$service" dep_optional | tr '\n' ' ') " == *" $dep "* ]]; then
      deps_down+=("$dep")
    else
      stop "$service depends on $dep, which is not running. Start it first (docker compose up -d $dep)."
    fi
  done
  if [[ -z $running ]]; then
    mode_of[$service]="start"
    why_of[$service]="it is not running"
    return
  fi
  if (($(wc -w <<<"$all") != $(wc -w <<<"$running"))); then
    # Beside a running container, docker rollout replaces only the stopped ones.
    stop "$service has stopped containers beside the running one. Remove them with: docker compose rm -f $service"
  fi
  ((${#deps_down[@]} == 0)) || reasons+=("docker rollout would start ${deps_down[*]}, which is not running")
  [[ -z $(fact "$service" container_name) ]] || reasons+=("it has a container_name")
  [[ -z $(fact "$service" ports) ]] || reasons+=("it publishes ports")
  case "$(fact "$service" network_mode)" in
    host | service:* | container:*) reasons+=("it shares another network namespace (network_mode)") ;;
  esac
  restart="$(fact "$service" restart)"
  [[ $restart == "unless-stopped" || $restart == "always" ]] || reasons+=("its restart policy is not unless-stopped or always")
  hc="$(fact "$service" healthcheck)"
  if [[ -n $(fact "$service" healthcheck_disable) ]]; then
    hc=""
  elif [[ -z $hc ]]; then
    # Read first, then searched: grep -q in a pipe could end the reader early and fail the pipe.
    image_hc="$(docker image inspect -f '{{json .Config.Healthcheck}}' "${image_of[$service]}")" || stop "Could not read ${image_of[$service]} from Docker."
    if grep -q '"Test":\["CMD' <<<"$image_hc"; then
      hc=1
    fi
  fi
  [[ -n $hc ]] || reasons+=("it has no health check")
  old="$(head -n 1 <<<"$running")"
  [[ $(container_label "$old" "$ZERO_DOWNTIME_LABEL") == "1" ]] || reasons+=("the running version cannot run beside another instance yet")
  [[ -n $(container_label "$old" "$DRAIN_LABEL") ]] || reasons+=("its running container has no $DRAIN_LABEL label")
  labels="$(docker inspect -f '{{range $k, $v := .Config.Labels}}{{println $k}}{{end}}' "$old")" || stop "Could not read the labels of $service from Docker."
  if grep -q '^traefik\.' <<<"$labels" &&
    ! grep -Eq '^traefik\.http\.services\.[^.]+\.loadbalancer\.healthcheck\.path$' <<<"$labels"; then
    reasons+=("its running container has no Traefik service health check")
  fi
  # With SSO, both containers must sign and read the same session cookies.
  if [[ -n $(fact "$service" env:OIDC_ISSUER_BASE_URL) || -n $(fact "$service" env:OIDC_CLIENT_ID) || -n $(fact "$service" env:OIDC_CLIENT_SECRET) ]]; then
    local want have
    want="$(new_secret_json "$service")" || stop "docker compose config failed: see above."
    have="$(old_secret_json "$old")"
    if [[ -z $want ]]; then
      reasons+=("SSO is on and SESSION_SECRET is not set")
    elif [[ $want != "$have" ]]; then
      reasons+=("SSO is on and the running container has another SESSION_SECRET")
    fi
  fi
  if ((${#reasons[@]} > 0)); then
    mode_of[$service]="recreate"
    local IFS=';'
    why_of[$service]="${reasons[*]}"
    why_of[$service]="${why_of[$service]//;/; }"
  else
    mode_of[$service]="rollout"
    why_of[$service]=""
  fi
}

need_rollout=""
for service in "${services[@]}"; do
  plan_service "$service"
  case "${mode_of[$service]}" in
    rollout) log "Update without downtime: $service"; need_rollout=1 ;;
    recreate) warn "Update with a short downtime: $service, because ${why_of[$service]}" ;;
    start) log "Start: $service (${why_of[$service]})" ;;
  esac
done
if [[ -n $need_rollout ]]; then
  have="$(docker rollout --version 2>/dev/null)" || stop "The docker rollout plugin is not installed: https://github.com/wowu/docker-rollout ($ROLLOUT_VERSION)"
  [[ $have == "docker-rollout version $ROLLOUT_VERSION" ]] || stop "This script is tested with docker rollout $ROLLOUT_VERSION, and '${have:-unknown}' is installed. Install $ROLLOUT_VERSION."
fi

for service in "${services[@]}"; do
  # Read right before acting: a container may have stopped or come back during the pull.
  plan_service "$service"
  # .env first, so that a service reading it (env_file) starts with it.
  if [[ -n $version && -z $edited ]]; then
    write_tag "$version" || stop "Could not write $tag_var=$version into .env."
    log "$tag_var=$version in .env."
  fi
  case "${mode_of[$service]}" in
    rollout)
      log "Rolling $service"
      action=(docker rollout --timeout "$ROLLOUT_TIMEOUT" --wait-after-healthy "$SETTLE_SECONDS" "$service")
      ;;
    *)
      if [[ ${mode_of[$service]} == "start" ]]; then
        log "Starting $service"
      else
        warn "Recreating $service (short downtime): ${why_of[$service]}"
      fi
      # --no-deps: the services it depends on stay as they are.
      action=(docker compose up -d --no-deps --wait --wait-timeout "$ROLLOUT_TIMEOUT" "$service")
      ;;
  esac
  rolling="$service"
  ok=1
  "${action[@]}" || ok=""
  rolling=""
  # What runs now decides, not the exit code alone.
  if ! record "$service"; then
    # Unknown what runs: leave .env as it is rather than guess.
    rolled+=("$service")
    stop "Docker did not say what $service runs now. .env has $tag_var=$expected; check with: docker compose ps $service"
  fi
  if [[ -n $ok ]] && on_new_image_and_healthy "$service"; then
    log "$service is on ${image_of[$service]} and healthy."
    continue
  fi
  if [[ -z $(docker compose ps -q "$service") ]]; then
    # docker rollout v0.14 removes the old container when the new one vanished before it looked
    # (github.com/wowu/docker-rollout, NEW_CONTAINER_IDS empty). Bring the service back at once.
    err "No container of $service is running after the update. Starting it now."
    docker compose up -d --no-deps --wait --wait-timeout "$ROLLOUT_TIMEOUT" "$service" || true
    record "$service" || true
    stop "$service had no running container after the update and was started again. Check it with: docker compose ps $service; docker compose logs $service"
  fi
  if [[ -z $ok ]]; then
    stop "$service did not come up healthy on the new image; what ran before keeps running. See the output above, then: docker compose ps $service"
  fi
  stop "$service still has a container that is not on the new image or not healthy. Check them with: docker compose ps $service"
done

docker compose ps "${services[@]}"
log "Done: ${rolled[*]}"
