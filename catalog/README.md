# Directus backport catalog

YAML in this folder is the registry. The CLI and the Studio extension read a
local copy at runtime. **Check for updates** refreshes that copy from
[domdus/directus-backport](https://github.com/domdus/directus-backport) without
rebuilding. `advisories.yml` is the index. Patch blobs live under `patches/<GHSA>/`
only after a 12.x fix has been ported onto a pinned Directus build (`targets.yml`
for 11.17.4, `10.13.4.yml` for 10.13.4, `9.26.0.yml` for 9.26.0). New GHSAs come
from
[Directus security advisories](https://github.com/directus/directus/security).

Statuses:

| status | meaning |
|---|---|
| `already-fixed` | This Directus line already contains the fix |
| `needs-port` | Still open; no patch in this repo yet |
| `experimental` | Patch exists; apply with auto-rollback |
| `stable` | Applied on a real install without rollback |
| `wont-port` | Needs a 12.x refactor; use config/WAF or upgrade |

See [CONTRIBUTING.md](../CONTRIBUTING.md).
