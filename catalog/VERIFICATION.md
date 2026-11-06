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
and the port stays `experimental`. A dash means there is no port for that version. `u` means a port exists but has not
been run against a live instance yet: it applies, parses and rolls back cleanly in
`npm run verify:catalog`, and nothing more is claimed, so it stays `experimental`.

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
| GHSA-mv33-9f6j-pfmc | - | u | - |
| GHSA-393c-p46r-7c95 | - | u | - |
| GHSA-8m32-p958-jg99 | - | u | u |
| GHSA-jr94-gj3h-c8rf | - | u | u |
| GHSA-3573-4c68-g8cc | - | u | - |
| GHSA-8jpw-gpr4-8cmh | - | u | u |
| GHSA-9x5g-62gj-wqf2 | - | u | u |
| GHSA-7cvf-pxgp-42fc | - | u | u |
| GHSA-rmjh-cf9q-pv7q | - | u | u |
| GHSA-x3vm-88hf-gpxp | - | u | u |
| GHSA-f24x-rm6g-3w5v | - | u | u |
| GHSA-j8xj-7jff-46mx | - | u | u |
| GHSA-rv78-qqrq-73m5 | - | u | u |
| GHSA-fm3h-p9wm-h74h | - | u | u |
| GHSA-7wq3-jr35-275c | - | u | u |
| GHSA-56p6-qw3c-fq2g | - | u | - |
| GHSA-pmf4-v838-29hg | - | u | u |
| GHSA-cff8-x7jv-4fm8 | - | - | u |
| GHSA-vw58-ph65-6rxp | - | - | u |
| GHSA-3fff-gqw3-vj86 | - | - | u |
| GHSA-68g8-c275-xf2m | - | - | u |
| GHSA-jgf4-vwc3-r46v | - | - | u |
| GHSA-632p-p495-25m5 | - | - | u |
| GHSA-7hmh-pfrp-vcx4 | - | - | u |
| GHSA-p8v3-m643-4xqx | - | - | u |
| GHSA-hxgm-ghmv-xjjm | - | - | u |
| GHSA-8p72-rcq4-h6pw | - | - | u |
| GHSA-qw9g-7549-7wg5 | - | - | u |

Limits of this table:

- SQLite was used for the database. `GHSA-chfm-g7r3-vv42` was checked on the SQL
  fragment, not on a live PostGIS server.
- `GHSA-8xp8-xrh2-88vr` was checked with a letter-case variant of an address. The
  accent variant in the advisory needs MySQL or MariaDB.
- On 10.13.4 and 9.26.0, `GHSA-j5h6-vqc3-phqh` adds cover for the wider `0.0.0.0/8`
  range and `::`. The literal `0.0.0.0` was already denied on those versions.
- `GHSA-p623-wgx3-wxp8` on 11.17.4 covers share deletes. The share update path is
  covered by `GHSA-7h45-q5jx-7r87`, so apply both.
