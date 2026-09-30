# libsql package portability (graph #201)

The normal libsql 0.5.29 loader selects a native optional dependency with
`currentTarget()` and `require('@libsql/' + target)`. Only `LIBSQL_JS_DEV`
uses `load(__dirname)`. Bundling that loader embeds the build machine's
absolute directory; this is a dormant packaging risk, not evidence of a live
SQLite outage or a cause of 429 responses.

The SQLite bookkeeping base already excludes libsql from its main Bun build
alongside the Agent SDK and jsonc-parser. libsql remains a runtime dependency.
No further package.json change is needed for this measure.

## Reproducible check

```sh
bun install --frozen-lockfile
node scripts/e2e-libsql-package.mjs
```

The harness runs the real `npm run build` (including postbuild), creates the
canonical `npm pack` tarball, and installs it with npm in an independent path.
No source tree or source node_modules is linked into that installation.
Package installation scripts are deliberately disabled: the native libsql
optional dependency is still installed; Claude's installer/model calls are
not part of this check. Runtime HOME/configuration and telemetry are synthetic.
The harness removes its disposable installation and database on exit.

The installed public server entry must create the telemetry SQLite schema
(falling back to memory fails). The harness then writes and reopens a synthetic
diagnostic row with the installed libsql, checks installed CLI help and declared
entry files, and rejects a bundled libsql loader or hardcoded libsql directory
in packaged JavaScript. Both runtime and artifact assertions are required.

For the canonical upstream negative control:

```sh
mkdir -p .evidence/libsql-packaging
npm pack @rynfar/meridian@1.78.0 --ignore-scripts --pack-destination .evidence/libsql-packaging
node scripts/e2e-libsql-package.mjs .evidence/libsql-packaging/rynfar-meridian-1.78.0.tgz
```

## Observed September 30, 2026

- macOS arm64, Bun 1.3.14, Node 22.23.3 and 26.3.0, installed libsql 0.5.29.
- Upstream 1.78.0 tarball: SQLite opened, written and reopened; exit 1 because
  its loader is bundled. The artifact embeds
  `/home/runner/work/meridian/meridian/node_modules/libsql`.
- Assigned SQLite base, freshly built/packed 1.78.0-hub.1: exit 0;
  `bundledLoader=false`, `buildPathLeak=false`; packaged SQLite and CLI checks pass.
- `npm run typecheck`: exit 0. Build/postbuild: exit 0 inside the harness.
- `npm test`: incomplete, stopped by the 240-second command deadline. Before
  stopping it reported failures in real Node deletion-executor/fence tests and
  the bookkeeping admission heartbeat negative control. Those wider SQLite
  areas are outside this change; the full suite is **not** claimed green.

Linux GNU/musl, Windows, other architectures, Nix/Docker, and an actual deployed
service have not been observed by this check. No release, deployment or risk
closure follows from it. Independent cold review/verifier remains a handoff gate.
