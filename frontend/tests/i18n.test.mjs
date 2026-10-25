import test from "node:test";
import assert from "node:assert/strict";
import { translate, LANGS } from "../js/i18n.js";

test("fills in variables", () => {
  assert.equal(translate("en", "PAIN_RISING", { a: 1, b: 2, c: 3 }), "Pain has risen for 3 days: 1, 2, 3.");
});

test("falls back to English for a missing key and to the key itself when unknown", () => {
  assert.equal(translate("ta", "copied"), "Copied");
  assert.equal(translate("hi", "no_such_key"), "no_such_key");
});

test("every finding code the trend engine can return has a message in every language", () => {
  for (const { code } of LANGS) {
    for (const key of ["FEVER_LIMIT", "WOUND_DISCHARGE", "PAIN_LIMIT", "PAIN_RISING", "FEVER_RISING"]) {
      const text = translate(code, key, { fever: 101, limit: 100.4, pain: 9, a: 1, b: 2, c: 3, prev: 99, cur: 100 });
      assert.ok(!/\{\w+\}/.test(text), `${code}.${key} has an unfilled variable`);
      if (code !== "en") assert.notEqual(text, translate("en", key, { fever: 101, limit: 100.4, pain: 9, a: 1, b: 2, c: 3, prev: 99, cur: 100 }));
    }
  }
});
