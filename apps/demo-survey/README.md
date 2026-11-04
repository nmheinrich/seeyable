# Demo survey — technical test fixture

## Status

`index.html` in this folder is the **architecture test fixture used for
the snapshot evaluation**. It exists so the DOM/ARIA and CDP
snapshot implementations could be run against an identical, controlled
page and compared (`docs/spike/`, `docs/decision-snapshot.md`).

- It is a **pre-existing technical test fixture, not product UI**. The
  judging package includes it as a controlled, account-free test target.

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

## Provenance

The Product Owner's project brief identifies this survey as a pre-existing
fixture. It is excluded from claims of hackathon-built Seeyable product
work. Its appearance in this repository's history does not establish when
the underlying fixture was originally built. An earlier version of this
note inferred provenance from repository history and conflicted with that
brief; follow the owner-provided provenance rather than that inference.

## Running it

Serve over local HTTP (content scripts do not run on `file://` without
explicit file-access grants):

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory apps/demo-survey
# open http://127.0.0.1:8765/index.html
```
