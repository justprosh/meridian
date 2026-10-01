# libsql package portability check

The normal libsql 0.5.29 loader selects a native optional dependency with
`currentTarget()` and `require('@libsql/' + target)`. Only `LIBSQL_JS_DEV`
uses `load(__dirname)`. Bundling that loader embeds the build machine's
absolute directory, so the package build leaves libsql external and installs
its native optional dependency at runtime.

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

## Result scope

Record the package digest, libsql and Node versions, OS/architecture and exit
code for each run. A working local SQLite probe alone does not rule out a
bundled-loader defect; the installed artifact checks matter too. This check
does not establish model behavior, full-suite success or acceptance on other
platforms. Run it on each supported target before claiming package portability.
