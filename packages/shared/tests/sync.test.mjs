"use strict";
/* Mirror-sync guard: the extension cannot load scripts outside its own root
 * (MV3), so apps/extension/lib/plan-schema.js mirrors the canonical
 * packages/shared/plan-schema.js. This test fails loudly on any drift:
 * edit the canonical file, then copy it over the mirror byte-for-byte. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("extension mirror is byte-identical to the canonical schema", () => {
  const canonical = readFileSync(join(here, "..", "plan-schema.js"), "utf8");
  const mirror = readFileSync(join(here, "..", "..", "..", "apps", "extension", "lib", "plan-schema.js"), "utf8");
  assert.equal(mirror, canonical, "copy packages/shared/plan-schema.js over apps/extension/lib/plan-schema.js");
});
