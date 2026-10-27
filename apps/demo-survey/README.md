# Demo survey — technical test fixture

## Status

`index.html` in this folder is the **architecture test fixture used for
the snapshot evaluation**. It exists so the DOM/ARIA and CDP
snapshot implementations could be run against an identical, controlled
page and compared (`docs/spike/`, `docs/decision-snapshot.md`).

- It is a **technical test fixture, not product UI** and not a
  demonstration page. No demonstration page has been selected yet.

## Contents (20 snapshot-visible controls + 2 hidden)

The page deliberately mixes labelling strategies so label quality and
coverage can be compared: `label[for]`, wrapping `<label>`,
`aria-label`, `aria-labelledby`, placeholder-only, title-only, a
`fieldset`/`legend` radio+checkbox group, select/textarea/search/
spinbutton/switch, disabled and `aria-expanded` probes, a password
field (value must be redacted in snapshots), and two hidden controls
(a `hidden` button and a `display:none` subtree) that must not appear
in either snapshot.

Measured result (headless Chrome 156): DOM/ARIA snapshot returns the
20 visible controls; CDP returns the same 20 names among its 120 AX
nodes. See `docs/spike/dom-snapshot.json` and
`docs/spike/cdp-snapshot.json`.

## Provenance (from available evidence)

- The repository's only commit at spike start was `e2b9a1d`
  ("first commit", README only). No `apps/` directory and no survey
  page existed in git history or in the workspace when the snapshot
  evaluation began.
- This `index.html` was **created on 2026-10-26 specifically as the
  test target for the snapshot evaluation**. It is not recovered or
  pre-existing work.
- An approximately 42-control survey mentioned in earlier planning
  material was a **proposed specification that was never
  implemented**. It does not exist as software and must not be
  described as completed.

## Running it

Serve over local HTTP (content scripts do not run on `file://` without
explicit file-access grants):

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory apps/demo-survey
# open http://127.0.0.1:8765/index.html
```
