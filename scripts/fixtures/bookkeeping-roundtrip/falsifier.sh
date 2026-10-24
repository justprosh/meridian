#!/bin/sh
# Falsifier for the resumeContextHash rollback round-trip (meridian-hub, дело №25/№26).
# RECONSTRUCTION (дело №31): the accepted bytes were deleted; this file is rebuilt
# from the case record. Identity with the accepted run is proven only by an
# identical step output on the original carrier.
#
# Runs INSIDE the meridian-185-fresh-prefix container (Debian bookworm, node 22,
# coreutils); run-falsifier.sh invokes it as `sh /probe/falsifier.sh` with the
# private store snapshot mounted read-only at /artifacts/snapshot.tgz and a
# writable tmpfs at /scratch.
#
# Contract:
#   - one compact JSON line per step on stdout (steps 0..7, the
#     stock-old-control step + final verdict);
#   - first failure: "FAIL <step>: <reason>" on stderr, exit 1; the reason may
#     carry redacted CLI diagnostics (probe.js redact: /scratch paths kept,
#     quoted strings, long hex and UUIDs masked, 240 chars max);
#   - store contents (mapping keys, session ids, hashes of real data) are never
#     printed — only counts, booleans, exit codes, phases, digests and
#     redacted diagnostics; raw CLI and node stderr is captured under /tmp and
#     never echoed (only its redacted last non-warning line may join a reason).
set -eu

N="${N:-1000}"
case "$N" in
    ''|*[!0-9]*) echo "FAIL init: N must be a positive integer" >&2; exit 1 ;;
esac

NEW=/opt/new/node_modules/@rynfar/meridian/dist/session-bookkeeping.js
RB=/opt/rollback/node_modules/@rynfar/meridian/dist/session-bookkeeping.js
OLD=/opt/old/node_modules/@rynfar/meridian/dist/session-bookkeeping.js
SNAPSHOT=/artifacts/snapshot.tgz

fail() {
    echo "FAIL $1: $2" >&2
    exit 1
}

# --- probe.js: CLI stdout parsing (metadata only) ----------------------------
cat > /tmp/probe.js <<'JS'
'use strict';
const fs = require('fs');
const sub = process.argv[2];

if (sub === 'fields') {
  // stdin: one JSON object from a bookkeeping CLI (phase, mappings, ...).
  // stdout: phase on line 1, mappings on line 2.
  // exit 2: not JSON; exit 3: fields missing or invalid.
  let o;
  try { o = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { process.exit(2); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) process.exit(2);
  if (typeof o.phase !== 'string') process.exit(3);
  if (!Number.isInteger(o.mappings) || o.mappings < 0) process.exit(3);
  process.stdout.write(o.phase + '\n' + String(o.mappings) + '\n');
  process.exit(0);
}

if (sub === 'error_has') {
  // stdin: one JSON object; argv[3]: phrase.
  // exit 0 iff o.error is a string containing the phrase; 1 otherwise; 2 not JSON.
  let o;
  try { o = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { process.exit(2); }
  const err = (o && typeof o === 'object') ? o.error : undefined;
  process.exit(typeof err === 'string' && err.includes(process.argv[3]) ? 0 : 1);
}

if (sub === 'redact') {
  // stdin -> stdout. /scratch paths are kept (they hold no store data);
  // double-quoted substrings, UUIDs and runs of 16+ hex become placeholders.
  let text = fs.readFileSync(0, 'utf8');
  const kept = [];
  text = text.replace(/\/scratch\/[^\s"']*/g, path => { kept.push(path); return '\u0000' + (kept.length - 1) + '\u0000'; });
  text = text.replace(/"(?:[^"\\]|\\.)*"/g, '"…"');
  text = text.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>');
  text = text.replace(/[0-9a-fA-F]{16,}/g, '<id>');
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => kept[Number(index)]);
  process.stdout.write(text.slice(0, 240));
  process.exit(0);
}

process.exit(64);
JS

# --- lib.js: normalized digest, injection, round-trip checks ------------------
cat > /tmp/lib.js <<'JS'
'use strict';
// Prints only counts, booleans, exit codes and digests — never store contents.
const fs = require('fs');
const crypto = require('crypto');

const DROP = ['revision', 'generationId', 'lastUsedAt', 'resumeContextHash'];

function fail(msg) {
  process.stderr.write(String(msg) + '\n');
  process.exit(1);
}

// node:sqlite is unflagged from node 22.13 / 23.4; on older nodes re-exec once
// with --experimental-sqlite.
let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  const r = require('child_process').spawnSync(
    process.execPath,
    ['--experimental-sqlite', __filename].concat(process.argv.slice(2)),
    { stdio: 'inherit' }
  );
  process.exit(r.status === null ? 1 : r.status);
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

function normalizedEntry(e) {
  // sessions.json can hold non-object top-level values (key count != mappings
  // count); digest those as-is, without field dropping.
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return canon(e);
  const c = Object.assign({}, e);
  for (const k of DROP) delete c[k];
  return canon(c);
}

function digestSessions(s) {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(s).sort()) {
    h.update(k + '\n' + JSON.stringify(normalizedEntry(s[k])) + '\n');
  }
  return h.digest('hex');
}

function loadSessions(p, what) {
  let s;
  try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { fail(what + ': unreadable'); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail(what + ': not a JSON object');
  return s;
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'baseline') {
  // stdout line 1: key count; line 2: normalized digest. Also writes the
  // key->claudeSessionId map to /scratch/baseline-sids.json (mode 600, never
  // printed).
  const s = loadSessions(argv[1] + '/sessions.json', 'baseline sessions.json');
  const sids = {};
  for (const k of Object.keys(s)) {
    if (!s[k] || typeof s[k] !== 'object') continue; // non-session values carry no ids
    sids[k] = s[k].claudeSessionId;
  }
  try {
    fs.writeFileSync('/scratch/baseline-sids.json', JSON.stringify(sids), { mode: 0o600 });
    fs.chmodSync('/scratch/baseline-sids.json', 0o600);
  } catch (e) { fail('cannot write baseline-sids.json'); }
  console.log(String(Object.keys(s).length));
  console.log(digestSessions(s));
  process.exit(0);
}

if (cmd === 'inject') {
  // For the first N history rows (ordered by mapping_key) set
  // resumeContextHash = sha256("witness:" + key) in one transaction; save the
  // expected hashes to /scratch/injected.json (mode 600, never printed).
  const dir = argv[1];
  const n = Number(argv[2]);
  const db = new DatabaseSync(dir + '/session-bookkeeping.sqlite');
  let keys;
  try {
    keys = db.prepare(
      "SELECT mapping_key FROM mapping_history WHERE encoding = 'history' ORDER BY mapping_key LIMIT ?"
    ).all(n);
  } catch (e) { fail('mapping_history query failed'); }
  if (!Array.isArray(keys) || keys.length !== n) {
    fail('history rows available: ' + (Array.isArray(keys) ? keys.length : 'n/a') + ', need ' + n);
  }
  const upd = db.prepare(
    "UPDATE mapping_history SET history_json = json_set(history_json, '$.resumeContextHash', ?) WHERE mapping_key = ?"
  );
  const expected = {};
  let changes = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const row of keys) {
      const key = row.mapping_key;
      if (typeof key !== 'string') throw new Error('non-string mapping_key at index ' + changes);
      const hash = crypto.createHash('sha256').update('witness:' + key).digest('hex');
      changes += Number(upd.run(hash, key).changes);
      expected[key] = hash;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* nothing to roll back */ }
    fail('injection transaction failed after ' + changes + ' of ' + n + ' rows');
  }
  if (changes !== n) fail('total changes ' + changes + ' != ' + n);
  try {
    fs.writeFileSync('/scratch/injected.json', JSON.stringify(expected), { mode: 0o600 });
    fs.chmodSync('/scratch/injected.json', 0o600);
  } catch (e) { fail('cannot write injected.json'); }
  db.close();
  process.exit(0);
}

if (cmd === 'check') {
  // Compare an exported sessions.json against the baseline:
  //   - every injected key present with its expected resumeContextHash (N of N);
  //   - no non-injected key carries a resumeContextHash that was not in baseline,
  //     and none lost one it had in baseline;
  //   - normalized digest equals the baseline digest;
  //   - claudeSessionId equals baseline for every key; non-session values equal.
  // stdout: the step's compact JSON line.
  const step = argv[1];
  const cur = loadSessions(argv[2] + '/sessions.json', 'current sessions.json');
  const base = loadSessions(argv[3] + '/sessions.json', 'baseline sessions.json');
  let inj;
  try { inj = JSON.parse(fs.readFileSync(argv[4], 'utf8')); } catch (e) { fail('injected.json: unreadable'); }
  const n = Number(argv[5]);
  if (!inj || typeof inj !== 'object') fail('injected.json: not a JSON object');
  const injCount = Object.keys(inj).length;
  if (injCount !== n) fail('injected.json: ' + injCount + ' keys, expected ' + n);

  let missing = 0;
  let mismatched = 0;
  for (const [k, want] of Object.entries(inj)) {
    const e = cur[k];
    if (!e || typeof e !== 'object') { missing++; continue; }
    if (e.resumeContextHash !== want) mismatched++;
  }
  if (missing) fail(missing + ' injected keys absent from export');
  if (mismatched) fail(mismatched + ' injected keys carry a wrong resumeContextHash');

  let absent = 0;
  let foreign = 0;
  let sidMismatch = 0;
  let lostHash = 0;
  let nonObjectMismatch = 0;
  for (const k of Object.keys(cur)) {
    const a = cur[k];
    const b = base[k];
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      if (a.claudeSessionId !== b.claudeSessionId) sidMismatch++;
      if (k in inj) continue;
      const ch = a.resumeContextHash;
      const bh = b.resumeContextHash;
      if (ch === undefined) {
        if (bh !== undefined) lostHash++;
        continue;
      }
      if (bh === undefined || ch !== bh) foreign++;
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      // non-object value (or key absent on one side): exact JSON must match
      nonObjectMismatch++;
    }
  }
  for (const k of Object.keys(base)) {
    if (!(k in cur)) absent++;
  }
  if (absent) fail(absent + ' keys diverge from the baseline key set');
  if (foreign) fail(foreign + ' non-injected keys carry a resumeContextHash not in baseline');
  if (lostHash) fail(lostHash + ' non-injected keys lost their resumeContextHash');
  if (nonObjectMismatch) fail(nonObjectMismatch + ' non-session values differ from baseline');
  if (sidMismatch) fail(sidMismatch + ' keys changed claudeSessionId');

  if (digestSessions(cur) !== digestSessions(base)) fail('normalized digest differs from baseline');
  console.log(JSON.stringify({ step: step, preserved: n, digestEqual: true, sdkIdsEqual: true }));
  process.exit(0);
}

fail('unknown subcommand: ' + String(cmd));
JS

# --- shared shell helpers -----------------------------------------------------
unpack_snapshot() {
    _step="$1"; _dir="$2"
    rm -rf "$_dir"
    mkdir -m 700 "$_dir" || fail "$_step" "cannot mkdir ${_dir}"
    tar -xzf "$SNAPSHOT" -C "$_dir" || fail "$_step" "cannot extract snapshot"
    find "$_dir" -type f -exec chmod 600 {} + || fail "$_step" "cannot chmod store files"
}

copy_store() {
    _step="$1"; _src="$2"; _dst="$3"
    rm -rf "$_dst"
    cp -R "$_src" "$_dst" || fail "$_step" "cannot copy ${_src} to ${_dst}"
}

# redact TEXT — probe.js redact filter: /scratch paths kept, double-quoted
# strings, UUIDs and 16+ hex runs masked, 240 chars max.
redact() {
    printf '%s' "$1" | node /tmp/probe.js redact
}

# run_cli STEP CMD... — run a bookkeeping CLI expected to succeed.
# Sets CLI_PHASE / CLI_MAPPINGS from its JSON stdout. On a nonzero exit the
# FAIL reason carries redacted diagnostics: the CLI's phase / exit_code / error
# and the last non-warning stderr line, both through the redact filter; the
# raw streams stay under /tmp.
CLI_PHASE=''
CLI_MAPPINGS=''
run_cli() {
    _step="$1"
    shift
    _rc=0
    _out="$("$@" 2>/tmp/cli-stderr.log)" || _rc=$?
    if [ "$_rc" -ne 0 ]; then
        _diag="cli exited ${_rc}"
        _jf="$(printf '%s' "$_out" | node -e '
let o;
try { o = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch (e) { process.exit(3); }
if (!o || typeof o !== "object" || Array.isArray(o)) process.exit(3);
const p = [];
if (o.phase !== undefined) p.push("phase=" + o.phase);
if (o.exit_code !== undefined) p.push("exit_code=" + o.exit_code);
if (o.error !== undefined) p.push("error=" + String(o.error).replace(/\s+/g, " "));
process.stdout.write(p.join("; "));
' 2>/dev/null)" || _jf=''
        _jr="$(redact "$_jf")" || _jr=''
        if [ -n "$_jr" ]; then
            _diag="$_diag; stdout: $_jr"
        fi
        _sl=''
        if [ -s /tmp/cli-stderr.log ]; then
            _sl="$(grep -v -e '^(node:' -e 'ExperimentalWarning' /tmp/cli-stderr.log | tail -n 1)"
            _sl="$(redact "$_sl")" || _sl=''
        fi
        if [ -n "$_sl" ]; then
            _diag="$_diag; stderr: $_sl"
        fi
        fail "$_step" "$_diag"
    fi
    _prc=0
    _pair="$(printf '%s' "$_out" | node /tmp/probe.js fields)" || _prc=$?
    if [ "$_prc" -ne 0 ]; then
        fail "$_step" "cli stdout unusable: cli exit 0, parser exit ${_prc}, ${#_out} bytes"
    fi
    CLI_PHASE="$(printf '%s\n' "$_pair" | sed -n 1p)"
    CLI_MAPPINGS="$(printf '%s\n' "$_pair" | sed -n 2p)"
}

# run_check STEP CUR_DIR BASE_DIR INJ_JSON N — lib.js round-trip check; on
# success its compact JSON line goes straight to stdout.
run_check() {
    _step="$1"
    shift
    _crc=0
    node /tmp/lib.js check "$_step" "$@" 2>/tmp/check-stderr.log || _crc=$?
    if [ "$_crc" -ne 0 ]; then
        _reason="$(grep -v '^(' /tmp/check-stderr.log | tail -n 1)"
        fail "$_step" "check failed: ${_reason:-helper exit ${_crc}}"
    fi
}

pkg_version() {
    node -e 'try { process.stdout.write(String(require(process.argv[1]).version)) } catch (e) { process.exit(1) }' "$1" 2>/dev/null
}

# --- step 0: versions -----------------------------------------------------------
v_new="$(pkg_version /opt/new/node_modules/@rynfar/meridian/package.json)" || v_new=""
v_rb="$(pkg_version /opt/rollback/node_modules/@rynfar/meridian/package.json)" || v_rb=""
v_old="$(pkg_version /opt/old/node_modules/@rynfar/meridian/package.json)" || v_old=""

[ -n "${EXPECT_NEW_VERSION:-}" ] && [ -n "${EXPECT_RB_VERSION:-}" ] && [ -n "${EXPECT_OLD_VERSION:-}" ] \
    || fail versions "EXPECT_NEW_VERSION, EXPECT_RB_VERSION and EXPECT_OLD_VERSION must be set"
[ -n "$v_new" ] || fail versions "cannot read NEW package.json"
[ "$v_new" = "$EXPECT_NEW_VERSION" ] || fail versions "NEW version is ${v_new}, expected ${EXPECT_NEW_VERSION}"
[ -n "$v_rb" ] || fail versions "cannot read RB package.json"
[ "$v_rb" = "$EXPECT_RB_VERSION" ] || fail versions "RB version is ${v_rb}, expected ${EXPECT_RB_VERSION}"
[ -n "$v_old" ] || fail versions "cannot read OLD package.json"
[ "$v_old" = "$EXPECT_OLD_VERSION" ] || fail versions "OLD version is ${v_old}, expected ${EXPECT_OLD_VERSION}"
printf '{"step":"versions","new":"%s","rollback":"%s","old":"%s"}\n' "$v_new" "$v_rb" "$v_old"

# --- step 1: baseline -------------------------------------------------------------
unpack_snapshot baseline /scratch/base
run_cli baseline node "$NEW" export-json --session-dir /scratch/base --writers-stopped --json
[ "$CLI_PHASE" = "exported" ] || fail baseline "phase is ${CLI_PHASE}, expected exported"
BASELINE_MAPPINGS="$CLI_MAPPINGS"

_bl="$(node /tmp/lib.js baseline /scratch/base)" || fail baseline "digest helper failed"
BASE_COUNT="$(printf '%s\n' "$_bl" | sed -n 1p)"
BASELINE_DIGEST="$(printf '%s\n' "$_bl" | sed -n 2p)"
case "$BASE_COUNT" in
    ''|*[!0-9]*) fail baseline "digest helper returned no key count" ;;
esac
printf '%s' "$BASELINE_DIGEST" | grep -qE '^[0-9a-f]{64}$' || fail baseline "digest helper returned no sha256 digest"
printf '{"step":"baseline","mappings":%s,"count":%s,"digest":"%s"}\n' "$BASELINE_MAPPINGS" "$BASE_COUNT" "$BASELINE_DIGEST"

# --- step 2: inject -----------------------------------------------------------------
unpack_snapshot inject /scratch/c
_irc=0
node /tmp/lib.js inject /scratch/c "$N" 2>/tmp/inject-stderr.log || _irc=$?
if [ "$_irc" -ne 0 ]; then
    _reason="$(grep -v '^(' /tmp/inject-stderr.log | tail -n 1)"
    fail inject "injection failed: ${_reason:-helper exit ${_irc}}"
fi
[ -f /scratch/injected.json ] || fail inject "injected.json was not written"
chmod 600 /scratch/injected.json
printf '{"step":"inject","injected":%s}\n' "$N"

# --- step 3: new-inspect --------------------------------------------------------------
run_cli new-inspect node "$NEW" inspect --session-dir /scratch/c --json
[ "$CLI_PHASE" = "ready" ] || fail new-inspect "phase is ${CLI_PHASE}, expected ready"
[ "$CLI_MAPPINGS" -eq "$BASELINE_MAPPINGS" ] || fail new-inspect "mappings ${CLI_MAPPINGS} != baseline ${BASELINE_MAPPINGS}"
printf '{"step":"new-inspect","mappings":%s}\n' "$CLI_MAPPINGS"

# --- step 3b: stock-old-control ------------------------------------------------
# OLD must export an untouched snapshot, so step 4's refusal is caused by the
# injected field and nothing else in the snapshot.
unpack_snapshot stock-old-control /scratch/ctl
run_cli stock-old-control node "$OLD" export-json --session-dir /scratch/ctl --writers-stopped --json
[ "$CLI_PHASE" = "exported" ] || fail stock-old-control "phase is ${CLI_PHASE}, expected exported"
printf '{"step":"stock-old-control","phase":"exported","exitCode":0}\n'
rm -rf /scratch/ctl

# --- step 4: stock-old-refuses ----------------------------------------------------------
copy_store stock-old-refuses /scratch/c /scratch/neg
_orc=0
_oref="$(node "$OLD" export-json --session-dir /scratch/neg --writers-stopped --json 2>/tmp/old-stderr.log)" || _orc=$?
if [ "$_orc" -eq 0 ]; then
    fail stock-old-refuses "stock OLD export exited 0 — accepted the new history field"
fi
if [ "$_orc" -ne 5 ]; then
    fail stock-old-refuses "expected exit 5, got ${_orc}"
fi
_pprc=0
printf '%s' "$_oref" | node /tmp/probe.js error_has "unexpected mapping history field" || _pprc=$?
if [ "$_pprc" -eq 2 ]; then
    fail stock-old-refuses "refusal stdout is not valid JSON (exit was 5)"
fi
if [ "$_pprc" -ne 0 ]; then
    fail stock-old-refuses "refusal error does not mention 'unexpected mapping history field'"
fi
printf '{"step":"stock-old-refuses","exitCode":5,"refused":true}\n'
rm -rf /scratch/neg

# --- step 5: rollback-export --------------------------------------------------------------
copy_store rollback-export /scratch/c /scratch/rb
rm -rf /scratch/c
run_cli rollback-export node "$RB" export-json --session-dir /scratch/rb --writers-stopped --json
[ "$CLI_PHASE" = "exported" ] || fail rollback-export "phase is ${CLI_PHASE}, expected exported"
run_check rollback-export /scratch/rb /scratch/base /scratch/injected.json "$N"

# --- step 6: new-migrate --------------------------------------------------------------------
run_cli new-migrate node "$NEW" migrate --session-dir /scratch/rb --writers-stopped --json
[ "$CLI_PHASE" = "ready" ] || fail new-migrate "phase is ${CLI_PHASE}, expected ready"
[ "$CLI_MAPPINGS" -eq "$BASELINE_MAPPINGS" ] || fail new-migrate "mappings ${CLI_MAPPINGS} != baseline ${BASELINE_MAPPINGS}"
printf '{"step":"new-migrate","mappings":%s}\n' "$CLI_MAPPINGS"

# migrate archives the JSON exports away; if one survived, step 7 would check
# a stale export, not what NEW's re-export writes.
[ ! -e /scratch/rb/sessions.json ] || fail new-reexport "sessions.json still present after migrate; re-export would not be fresh"
[ ! -e /scratch/rb/session-gc.json ] || fail new-reexport "session-gc.json still present after migrate; re-export would not be fresh"

# --- step 7: new-reexport ---------------------------------------------------------------------
run_cli new-reexport node "$NEW" export-json --session-dir /scratch/rb --writers-stopped --json
[ "$CLI_PHASE" = "exported" ] || fail new-reexport "phase is ${CLI_PHASE}, expected exported"
run_check new-reexport /scratch/rb /scratch/base /scratch/injected.json "$N"

printf '{"verdict":"all-steps-passed","N":%s}\n' "$N"
