# Adding a backport

This catalog is maintained here and published at
[domdus/directus-backport](https://github.com/domdus/directus-backport).
Installs pull new overlays from that repo without rebuilding the extension.
Watch
[Directus security advisories](https://github.com/directus/directus/security)
for new GHSAs. When 12.x ships a fix that 9.26.0 / 10.13.4 / 11.17.4 still
lack, add the advisory, port it onto those pinned trees, push, then refresh
on the host.

A patch is a named, reversible diff against one published Directus
`node_modules` tree. If Directus ships an official fix on that line, mark the
advisory `already-fixed` and delete the patch.

## Rules

1. One GHSA per folder: `catalog/patches/GHSA-xxxx-xxxx-xxxx/`
2. Pin `before_sha256` / `after_sha256` to the exact Directus version you tested
   (`targets.yml` for 11.17.4, `10.13.4.yml` for 10.13.4, `9.26.0.yml` for 9.26.0).
3. New patches start as `experimental`. Promote to `stable` only after a real
   install survived restart + smoke login.
4. Do not include license-enforcement changes. This catalog is security stopgaps only.
5. Do not include exploits or proof-of-concept payloads. Link the GitHub advisory.

## When a new advisory lands

1. Read the GHSA (affected range, patched 12.x version, which files changed).
2. Add it to `catalog/advisories.yml` as `needs-port` if it still hits a pinned
   build. Skip it if the range never includes 9.26.0 / 10.13.4 / 11.17.4.
3. Port onto a playground of that exact version. Checksums:

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

5. Flip that GHSA to `experimental`. Run `npm test`. Verify apply + restart +
   rollback on the playground. Push `catalog/` to GitHub. Hosts opt in with
   **Check for updates** (or `directus-backport catalog --refresh`).

`replace` is preferred for tiny ports. Use `diff_file: change.patch` for larger ones.

## Why checksums refuse to apply

If the file bytes are not exactly the tree you tested, the CLI rolls back and
does nothing. That is the feature that keeps this from becoming a silent distro
of “whatever version you happen to have”.
