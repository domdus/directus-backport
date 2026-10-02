# Security Backports (Directus extension)

Studio UI for [directus-backport](../README.md) on **Directus 10.13.4** and
**11.17.4**. Patches are checksum-pinned to those builds. Other versions will not
load this extension, and overlays will not apply there.

Directus **9.26.0** is CLI-only (this Vue module will not load). Use the repo CLI
or `dist/cli.mjs` from a host that can reach that install.

The engine and emergency CLI ship in `dist/` (`api.js`, `app.js`, `cli.mjs`,
`rollback.mjs`). The catalog is not bundled: use **Check for Updates** in Studio
to fetch overlays from GitHub into `catalog-remote/`
(`domdus/directus-backport@main`). Fetch does not apply anything.

Applied GHSAs are stored in `desired.json` next to this extension. After
`node_modules` is reset, a boot hook re-applies them and exits once so the
process can reload. Rollback clears that list. `DIRECTUS_BACKPORT_AUTO=0`
disables the hook.

Apply and rollback exit the Node process. A process supervisor (or you) starts
Directus again.

## Install

Requires Directus **10.13.4** or **11.17.4** (`directus:extension.host`).

```bash
# from repo root
npm install && npm run build
cd directus-extension-backport && npm install && npm run build
```

Install like any Directus extension: put `package.json` and `dist/` in
`…/extensions/directus-extension-backport/`, then enable **Security Backports**
under **Settings → Project Settings → Modules**. Open the module and use
**Check for Updates** once.

## Usage

![Security Backports catalog](docs/backport.png)

**Check for Updates** fetches the catalog. Apply ready GHSAs from the list.
**Rollback Last Apply** undoes the most recently applied remaining GHSA.
**Rollback All** undoes every applied backport. Settings can remove working
files (`desired.json`, snapshots).

If Directus does not start, Studio cannot help. From the host:

```bash
node …/extensions/directus-extension-backport/dist/cli.mjs rollback
node …/extensions/directus-extension-backport/dist/cli.mjs rollback --id GHSA-97xr-jchp-xm3c
node …/extensions/directus-extension-backport/dist/cli.mjs rollback --all
node …/extensions/directus-extension-backport/dist/cli.mjs apply --all --yes
node …/extensions/directus-extension-backport/dist/cli.mjs status

# Docker example
docker compose run --no-deps --entrypoint node directus \
  /directus/extensions/directus-extension-backport/dist/cli.mjs rollback
```

`dist/rollback.mjs` is the same emergency rollback without subcommands.
