#!/usr/bin/env bash
# Host wrapper for the resumeContextHash falsifier (meridian-hub, дело №25/№26).
# RECONSTRUCTION (дело №31): rebuilt from the case record, see falsifier.sh.
#
# (a) pins the image by its immutable ID and verifies its contents (artifact
#     sha256s and installed package versions) without the snapshot mounted;
# (b) prints the host snapshot's sha256 (reported, not asserted);
# (c) runs falsifier.sh inside the container — no network, read-only
#     filesystem, /scratch as a 4 GiB tmpfs, the snapshot and a separate
#     /etc/machine-id (process incarnation) read-only — teeing output to
#     falsifier-run.log and exiting with the container's status.
#
# Never uses --network host, never mounts anything besides falsifier.sh, the
# snapshot and the machine-id file (all read-only), never --privileged.
set -euo pipefail

# GENERIC variant: every carrier constant comes from the environment and is
# required — no defaults, so a hub.1 constant can never silently pin a hub.2
# run. Step logic is byte-identical to the canonical falsifier.sh; only step 0
# reads its expected versions from EXPECT_*_VERSION (passed into the container).
#   IMAGE_ID            immutable image ID (sha256:…), asserted via inspect
#   SNAPSHOT            host path of the private bookkeeping snapshot (.tar.gz)
#   MACHINE_ID          host path of the machine-id file mounted ro
#   EXPECT_{NEW,RB,OLD}_SHA      sha256 of /artifacts/{new,rollback,old}.tgz
#   EXPECT_{NEW,RB,OLD}_VERSION  package.json version under /opt/{new,rollback,old}
#   N                   injected history rows (default 1000)
IMAGE="${IMAGE_ID:-}"
for _var in IMAGE_ID SNAPSHOT MACHINE_ID EXPECT_NEW_SHA EXPECT_RB_SHA EXPECT_OLD_SHA \
    EXPECT_NEW_VERSION EXPECT_RB_VERSION EXPECT_OLD_VERSION; do
    [ -n "${!_var:-}" ] || { echo "run-falsifier: ${_var} must be set" >&2; exit 1; }
done
[[ "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "run-falsifier: IMAGE_ID must be sha256:<64 hex>" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${FALSIFIER_LOG:-$HERE/falsifier-run.log}"

die() { echo "run-falsifier: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
[ -f "$HERE/falsifier.sh" ] || die "falsifier.sh not found next to this script"
pinned="$(docker image inspect --format '{{.Id}}' "$IMAGE_ID")" \
    || die "image inspect failed: ${IMAGE} (${IMAGE_ID}) not present locally?"
[ "$pinned" = "$IMAGE_ID" ] || die "image id mismatch: inspect returned ${pinned}, expected ${IMAGE_ID}"
[ -f "$MACHINE_ID" ] || die "machine-id missing: $MACHINE_ID (the packaged runtime needs it for process-incarnation)"
[ -r "$MACHINE_ID" ] || die "machine-id not readable: $MACHINE_ID"

# --- a) image content check (no snapshot mounted) -----------------------------
probe='sha256sum /artifacts/new.tgz /artifacts/rollback.tgz /artifacts/old.tgz
node -e "const fs=require(\"fs\");for (const p of [\"new\",\"rollback\",\"old\"]) console.log(p+\" \"+JSON.parse(fs.readFileSync(\"/opt/\"+p+\"/node_modules/@rynfar/meridian/package.json\",\"utf8\")).version)"'
content="$(docker run --rm --network none --read-only --tmpfs /tmp:rw,size=67108864 \
    --entrypoint sh "$IMAGE_ID" -c "$probe")" || die "image content check failed (docker exit $?)"
printf '%s\n' "$content"

new_sha="$(awk '$2=="/artifacts/new.tgz" {print $1}' <<<"$content")"
rb_sha="$(awk '$2=="/artifacts/rollback.tgz" {print $1}' <<<"$content")"
old_sha="$(awk '$2=="/artifacts/old.tgz" {print $1}' <<<"$content")"
[ "$new_sha" = "$EXPECT_NEW_SHA" ] || die "image check: new.tgz sha256 is ${new_sha:-missing}, expected ${EXPECT_NEW_SHA}"
[ "$rb_sha" = "$EXPECT_RB_SHA" ] || die "image check: rollback.tgz sha256 is ${rb_sha:-missing}, expected ${EXPECT_RB_SHA}"
[ "$old_sha" = "$EXPECT_OLD_SHA" ] || die "image check: old.tgz sha256 is ${old_sha:-missing}, expected ${EXPECT_OLD_SHA}"

v_new="$(awk '$1=="new" {print $2}' <<<"$content")"
v_rb="$(awk '$1=="rollback" {print $2}' <<<"$content")"
v_old="$(awk '$1=="old" {print $2}' <<<"$content")"
[ "$v_new" = "$EXPECT_NEW_VERSION" ] || die "image check: NEW version is '${v_new:-missing}', expected ${EXPECT_NEW_VERSION}"
[ "$v_rb" = "$EXPECT_RB_VERSION" ] || die "image check: RB version is '${v_rb:-missing}', expected ${EXPECT_RB_VERSION}"
[ "$v_old" = "$EXPECT_OLD_VERSION" ] || die "image check: OLD version is '${v_old:-missing}', expected ${EXPECT_OLD_VERSION}"

# --- b) host snapshot check (printed, not asserted) -----------------------------
[ -f "$SNAPSHOT" ] || die "snapshot missing: $SNAPSHOT"
[ -r "$SNAPSHOT" ] || die "snapshot not readable: $SNAPSHOT"
shasum -a 256 "$SNAPSHOT"

# --- c) run the falsifier in the container --------------------------------------
touch "$LOG"
chmod 600 "$LOG"
status=0
docker run --rm --network none --read-only \
    --tmpfs /scratch:rw,size=4294967296,mode=0700 \
    --tmpfs /tmp:rw,size=67108864 \
    -e MERIDIAN_TELEMETRY_PERSIST=0 \
    -e N="${N:-1000}" \
    -e EXPECT_NEW_VERSION="$EXPECT_NEW_VERSION" \
    -e EXPECT_RB_VERSION="$EXPECT_RB_VERSION" \
    -e EXPECT_OLD_VERSION="$EXPECT_OLD_VERSION" \
    -v "$HERE/falsifier.sh:/probe/falsifier.sh:ro" \
    -v "$SNAPSHOT:/artifacts/snapshot.tgz:ro" \
    -v "$MACHINE_ID:/etc/machine-id:ro" \
    --entrypoint sh "$IMAGE_ID" /probe/falsifier.sh 2>&1 | tee "$LOG" || status="${PIPESTATUS[0]}"
exit "$status"
