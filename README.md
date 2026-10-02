# directus-backport

A **catalog + CLI + Studio module** for applying *optional* security stopgaps on
pinned Directus builds: **9.26.0** (CLI), **10.13.4**, and **11.17.4**. It is not
a Directus distro and not a fork.

Directus 12.x is where [upstream security advisories](https://github.com/directus/directus/security)
are patched. 9 / 10 / 11 lines do not get those backports. This repo tracks what
is still open on a given build, and when someone ports a fix, lets you apply that
**one** patch to `node_modules` with a snapshot you can undo.

Patches are checksum-pinned to the exact compiled tree they were tested on.
**10.13.4 is not “any 10.x”.** Another 10.13.x (or 11.16.x, 9.25.x, …) needs its
own overlay. The CLI will still detect those installs; it just will not apply a
pin that is not in the catalog. “Latest of each major” is only which overlays
exist today, not a hard rule.

```
npx tsx src/cli.ts          # prompt UI (run from the Directus folder)
directus-backport status
directus-backport rollback           # most recently applied GHSA
directus-backport rollback --all     # every applied backport
```

The CLI finds Directus from the current directory, the folder this command lives
in, or `/directus`. `--root` is only needed when the install is somewhere else.

## What happens if a patch breaks Directus

1. **Before any write**, the CLI copies the current files to
   `.directus-backport/snapshots/<id>/`.
2. It applies the patch. If the diff or checksum does not match, it restores
   immediately and stops.
3. If you pass a health URL (and optional restart command), it waits for
   `/server/ping`. On timeout it restores the snapshot and restarts again.
4. If Directus never comes back (crash loop), Studio cannot help you. Rollback
   is a file copy that does **not** need Directus:

```bash
directus-backport rollback
directus-backport rollback --id GHSA-97xr-jchp-xm3c
directus-backport rollback --all

# Docker, extension installed (same engine, Directus does not need to be up):
node /directus/extensions/directus-extension-backport/cli.mjs rollback
docker compose run --no-deps --entrypoint node directus \
  /directus/extensions/directus-extension-backport/cli.mjs rollback
```

Default is auto-rollback on failed health. `--no-rollback-on-fail` keeps the
broken files if you want to inspect them.

## No-code usage

### CLI usage

From the Directus install folder (or inside the container):

```bash
npm install && npm run build
node dist/cli.js
node dist/cli.js status
node dist/cli.js apply --yes GHSA-xw72-c69j-h2rj
node dist/cli.js rollback
node dist/cli.js rollback --id GHSA-xw72-c69j-h2rj
node dist/cli.js rollback --all
```

The UI detects the version, shows open advisories vs ready backports, asks
which to apply, then snapshots → apply → optional health wait → rollback on
fail.

Non-interactive:

```bash
node dist/cli.js apply --yes GHSA-xxxx-xxxx-xxxx \
  --health-url http://127.0.0.1:8055/server/ping \
  --restart-cmd "docker compose restart directus"
```

### Studio module

Build `directus-extension-backport/` and drop it into `/directus/extensions/directus-extension-backport`.
Admins get a **Security Backports** module: catalog, apply, rollback. `cli.mjs` is
copied with the extension. Apply still writes `node_modules` on that host. Apply
and rollback exit the Node process (`process.exit(0)`). They do not call Docker.
Whatever starts Directus — systemd, PM2, Docker `restart: unless-stopped`,
Kubernetes, or you — has to bring it back.

Studio loads on **10.13.4** and **11.17.4** only (Vue 3 host). On **9.26.0** use
the CLI; that Studio module will not load.

Optional host command (Settings → Install Host Command):

```bash
node /directus/directus-backport status
```

## Catalog

The engine ships with a **bundled** catalog so apply/rollback works offline.
**Check for updates** (or `directus-backport catalog --refresh`) pulls newer
overlays from [domdus/directus-backport](https://github.com/domdus/directus-backport)
on `main`. No environment variables. Fetch does **not** apply patches.

If GitHub is unreachable, the last cache (or the bundled copy) is used.

[`catalog/advisories.yml`](catalog/advisories.yml) is the registry: GHSA, severity,
affected range, upstream patched version, port status, risk, notes.

New 12.x-only fixes start as `needs-port`. That is intentional. The CLI will show
them and refuse to pretend a patch exists. We watch
[Directus security advisories](https://github.com/directus/directus/security)
and add overlays when a pin is ready. How: [CONTRIBUTING.md](CONTRIBUTING.md).
Status meanings: [catalog/README.md](catalog/README.md).

On **11.17.4**, advisories already fixed in 11.16–11.17 are marked `already-fixed`.
Everything patched only in 12.0 / 12.1 / 12.2 / 12.3 is still open.

On **10.13.4**, those 11.16–11.17 fixes are still open and wait until someone
ports them. GHSAs that only exist from 11.x onward (AI chat, Flows auth, settings
AI keys, telemetry) are out of range. The rest of the 12.x catalog has
checksum-pinned 10.13.4 overlays.

On **9.26.0**, the Studio module cannot load. The CLI can. Features that did not
exist yet (TUS, WebSocket CSWSH, public registration, AI, Flows auth) are out of
range. A small set of 12.x fixes whose compiled files still match 9.26.0 are
checksum-pinned; the rest wait for a 9.26.0-specific port.

## Persistence (Docker recreate)

Patches live in image `node_modules`, which a recreate wipes. Directus settings
would not help: the bytes still have to be written back into `node_modules`.

The Studio module writes **`desired.json` next to the extension** (on the
bind-mounted `./extensions` volume). A boot hook re-applies those GHSA ids, then
exits once so the process loads the patched files. Set `DIRECTUS_BACKPORT_AUTO=0`
to skip the hook.

For a Node install of Directus, the same file works as a postinstall step:

```bash
node dist/cli.js apply --yes --desired
```

`rollback` (Studio, CLI, or `rollback.mjs`) removes those ids so the next boot
does not put the patch back.

## Docker notes

Official images keep `node_modules` inside the container. Bind-mount `extensions`
and use `desired.json` as above. To bake patches into a derived image instead:

```dockerfile
FROM directus/directus:11.17.4
COPY directus-backport /opt/directus-backport
USER root
RUN cd /opt/directus-backport && npm ci --omit=dev \
 && node dist/cli.js apply --yes GHSA-… --root /directus
USER node
```

`--root` is used there because the command runs from `/opt/directus-backport`,
not from `/directus`. Checksums will reject a different build. Only list GHSAs
that are `stable` for that exact image tag.

## Commands

| | |
|---|---|
| `directus-backport` | Prompt UI |
| `status` | Counts + last snapshot |
| `catalog` | Full registry |
| `catalog --refresh` | Download the GitHub catalog (does not apply) |
| `apply [ids] --yes` | Non-interactive apply |
| `apply --yes --desired` | Apply ids from `desired.json` |
| `rollback` | Restore the most recently applied GHSA |
| `rollback --id GHSA-…` | Restore one advisory |
| `rollback --all` | Restore every applied backport |
| `verify --health-url` | Record ping result |
| `doctor` | Paths, version, last health |

`--json` is on the root command for the extension / scripts.

`--root <path>` is an advanced override when Directus is not discoverable from
cwd, this CLI, or `/directus`. `DIRECTUS_BACKPORT_ROOT` is the same override as
an environment variable. A fork can point Check for updates at another GitHub
repo with `DIRECTUS_BACKPORT_CATALOG` / `_REF`; a private mirror needs
`DIRECTUS_BACKPORT_GITHUB_TOKEN`. Normal installs set none of these.

## What this will not do

- Replay a v12 git commit onto v11 compiled JS automatically
- Replace upgrading to 12.x when you can
- Load the Studio module on Directus 9 (use the CLI)
