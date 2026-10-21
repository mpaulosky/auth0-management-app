import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainText, visibleLetters } from "./plain-text.mts";

describe("visibleLetters", () => {
  for (const [form, text] of [
    ["plain words", "Review notes"],
    ["emphasis and a heading mark", "## Re*view* **notes**"],
    ["HTML tags", "<h2>Review <b>notes</b></h2>"],
    ["a decimal character reference", "Re&#118;iew&#32;notes"],
    ["a hexadecimal character reference", "Re&#x76;iew&#x20;notes"],
    ["a named character reference", "Review&nbsp;notes"],
    ["fullwidth letters", "\uff32\uff45\uff56\uff49\uff45\uff57 \uff4e\uff4f\uff54\uff45\uff53"],
    ["a format character", "Review\u200e\u034f notes"],
  ] as const) {
    it(`reads ${form} as the letters a reader sees`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  it("takes a reference to a code point that doesn't exist for nothing, rather than throw", () => {
    assert.equal(visibleLetters("a&#99999999;b&#x110000;c"), "abc");
  });
});

describe("plainText", () => {
  it("escapes a leading tilde, which would otherwise open a code fence", () => {
    assert.equal(plainText("~~~x"), "\\~~~x");
  });
});
