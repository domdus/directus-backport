# Verification

Each row was tested on 2026-11-02 against paired stock and patched Directus
instances built from the official image of that exact version. No attack details
are recorded here. Read the linked advisory for those.

A port is `stable` only when all three hold:

1. The issue reproduced on the stock pin.
2. The same attempt was blocked once patched.
3. Legitimate use of the same feature matched stock.

`E` means tested end to end through the API. `F` means tested by calling the
patched function inside the real install, because the feature needs something the
lab did not have. `n/r` means it did not reproduce on stock, so nothing was proven
and the port stays `experimental`. A dash means there is no port for that version.

| Advisory | 11.17.4 | 10.13.4 | 9.26.0 |
|---|---|---|---|
| GHSA-32cw-mf7w-gpqr | E | n/r | E |
| GHSA-95f8-mvw7-gpj9 | E | E | n/r |
| GHSA-jvxj-w2qp-5vmx | E | - | - |
| GHSA-2xcm-7h22-3m66 | E | E | E |
| GHSA-xf86-hfpm-92xr | E | - | - |
| GHSA-97xr-jchp-xm3c | E | n/r | - |
| GHSA-gwvv-rr68-cmv6 | E | E | E |
| GHSA-7vcx-mhxq-9j96 | E | E | E |
| GHSA-mww8-4gwh-rjfw | E | E | - |
| GHSA-chfm-g7r3-vv42 | F | F | F |
| GHSA-3742-46gx-c8cc | E | E | - |
| GHSA-xjxq-pj7h-g676 | E | E | - |
| GHSA-4jw7-6mqj-vrhq | E | - | - |
| GHSA-g293-vf99-xv36 | E | E | E |
| GHSA-xw72-c69j-h2rj | E | E | E |
| GHSA-j5h6-vqc3-phqh | E | F | F |
| GHSA-c6w9-5g5j-jh2p | E | E | E |
| GHSA-fq27-7m2r-q6vm | E | - | - |
| GHSA-7h45-q5jx-7r87 | E | E | E |
| GHSA-8xp8-xrh2-88vr | E | E | - |
| GHSA-788p-cvgf-q973 | E | E | E |
| GHSA-p623-wgx3-wxp8 | E | E | E |
| GHSA-r9xq-xp38-j4j3 | E | - | - |
| GHSA-6hpw-rhhq-6xq3 | E | - | - |
| GHSA-ff8w-8crv-9rcf | E | E | - |
| GHSA-5h38-6755-g83w | E | E | E |
| GHSA-38hg-ww64-rrwc | - | - | E |
| GHSA-ph52-67fq-75wj | - | - | E |
| GHSA-6q22-g298-grjh | - | - | E |
| GHSA-mvv8-v4jj-g47j | - | - | n/r |
| GHSA-wxwm-3fxv-mrvx | - | - | E |
| GHSA-cf45-hxwj-4cfj | - | - | E |
| GHSA-wv3h-5fx7-966h | - | - | F |

Limits of this table:

- SQLite was used for the database. `GHSA-chfm-g7r3-vv42` was checked on the SQL
  fragment, not on a live PostGIS server.
- `GHSA-8xp8-xrh2-88vr` was checked with a letter-case variant of an address. The
  accent variant in the advisory needs MySQL or MariaDB.
- On 10.13.4 and 9.26.0, `GHSA-j5h6-vqc3-phqh` adds cover for the wider `0.0.0.0/8`
  range and `::`. The literal `0.0.0.0` was already denied on those versions.
- `GHSA-p623-wgx3-wxp8` on 11.17.4 covers share deletes. The share update path is
  covered by `GHSA-7h45-q5jx-7r87`, so apply both.
