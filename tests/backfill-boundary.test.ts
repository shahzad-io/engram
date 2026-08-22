import assert from "node:assert/strict";
import test from "node:test";
import * as application from "../dist/application/index.js";
import * as write from "../dist/application/write/index.js";

test("backfill transaction capability is not exported through live write barrels", () => {
  assert.equal("backfillCurationTransaction" in write, false);
  assert.equal("backfillCurationTransaction" in application, false);
});
