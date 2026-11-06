# Maintainer notes: keeping the catalog current

This is not a community patch pipeline. **We** watch
[Directus security advisories](https://github.com/directus/directus/security)
for fixes that land on **12.x**, decide whether a pinned build (9.26.0 /
10.13.4 / 11.17.4) is still exposed, and — when a port is worth it — add a
checksum-pinned overlay here.

Installs pull overlays from
[domdus/directus-backport](https://github.com/domdus/directus-backport) via
**Check for Updates** (or `catalog --refresh`). They do not invent ports.

A patch is a named, reversible diff against one published Directus
`node_modules` tree. If upstream later ships an official fix on that line, mark
the advisory `already-fixed` and delete the overlay.

## Rules

1. One GHSA per folder: `catalog/patches/GHSA-xxxx-xxxx-xxxx/`
2. Pin `before_sha256` / `after_sha256` to the exact Directus version tested
   (`targets.yml` for 11.17.4, `10.13.4.yml` for 10.13.4, `9.26.0.yml` for 9.26.0).
   Both are measured against the untouched published file, even when several
   advisories patch the same file. `after_sha256` is that file plus this patch only.
3. New overlays start as `experimental`. Promote to `stable` per pin, with
   `port.pins: { "11.17.4": stable }` in `advisories.yml`, only when the issue
   reproduced on the stock pin, the same attempt is blocked once patched, and
   legitimate use of that feature matches stock. Record it in
   [catalog/VERIFICATION.md](catalog/VERIFICATION.md).
4. Security stopgaps only — no license-enforcement changes.
5. No exploits or PoC payloads in this repo. Link the GitHub advisory. Keep any
   proof scripts outside the repo and record only the result.
6. Read the whole advisory and test its actual attack path. A port that fits the
   patch's own logic can still miss it, and a patch that loads can still fail at
   runtime on a version with different dependencies.

## When a new 12.x advisory lands

1. Read the GHSA (affected range, patched 12.x version, which files changed).
2. If it still hits 9.26.0 / 10.13.4 / 11.17.4, **port it** onto those pins in
   the same change. Do not leave it as `needs-port`. Skip it only if the range
   never includes those builds.
3. Port on a playground of that exact version. Checksums:

```bash
sha256sum node_modules/@directus/api/dist/some-file.js
```

4. Write the overlay (`targets.yml` / `10.13.4.yml` / `9.26.0.yml`):

```yaml
port:
  status: experimental
  risk: medium
  source_commit: "<v12 fix commit>"
  targets:
    - file: "@directus/api/dist/some-file.js"
      before_sha256: "…"
      after_sha256: "…"
      replace:
        - from: "old snippet unique enough to match once"
          to: "ported snippet"
```

5. Flip that GHSA to `experimental`. Run `npm test` and `npm run verify:catalog`.
   Verify apply + restart + rollback on the playground, and compare before and
   after with `node scripts/smoke.mjs <url> <admin-email> <admin-password>`. A patch
   can parse, load, and answer `/server/ping` while breaking a feature.
6. Sign on a trusted machine, then push `catalog/` to GitHub so hosts can refresh:

```bash
DIRECTUS_BACKPORT_SIGNING_KEY=~/.config/directus-backport/catalog-signing.pem npm run sign:catalog
```

The private key never goes to GitHub, not even as a CI secret. Otherwise a stolen
GitHub account could ship code to every host. Without a new signature, hosts refuse
the catalog and CI fails. To rotate the key, add the new public key to
`TRUSTED_KEYS` in `src/trust.ts`, release, and remove the old one a release later.

`replace` is required for anything that shares a file with another advisory, and
for rollback without a snapshot. `diff_file: change.patch` only applies to the exact
pinned file. Targets must be `dist` files of an `@directus/*` package.

## Fixes that landed before 12.x

11.17.4 is the newest pin, so a fix shipped in 10.x or 11.x can still be missing on
10.13.4 or 9.26.0. Register those advisories as `already-fixed` (true for 11.17.4)
with `port.pins` for the older versions, and narrow `affects` when a pin never had
the vulnerable code (say why in `notes`). Overlays come from
`scripts/gen-legacy-ghsas.mjs`. App-bundle fixes are `wont-port`.

## Why checksums refuse to apply

The CLI takes known catalog patches out of the file in memory and hashes what is
left. If that is not exactly the tree we tested, it refuses and writes nothing. That keeps this from becoming a silent distro of “whatever version
you happen to have”.
