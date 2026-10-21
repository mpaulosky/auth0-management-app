import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPITAL_LOOK_ALIKES, LOOK_ALIKES, plainText, visibleLetters } from "./plain-text.mts";

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

  // R61: a stray < and > far apart aren't a tag, so what's between them shows.
  for (const [form, text] of [
    ["a stray < and > on other lines", "a < b\n\n## Review notes\n\nc > d"],
    ["a < left open before the heading", "x <\n## Review notes"],
    ["a < before and a > after, in one line", "1 < 2 Review notes 3 > 2"],
  ] as const) {
    it(`reads ${form} without swallowing the words between them`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  // Round 2: GitHub shows a < that isn't a tag, so the words after it count.
  for (const [form, text] of [
    ["a < followed by a letter, then a blank line", "<x\n\n## Review notes\n\ny>"],
    ["a < followed by a letter, then a heading line", "a <b\n## Review notes\n>"],
    ["a < followed by a letter, with a comma inside", "Compare <x Review, notes> here"],
    ["a Markdown autolink", "<https://example.com/Review-notes>"],
    ["a generic type left open", "Result<T Review notes"],
  ] as const) {
    it(`reads ${form} as text`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  // Round 2: a tag inside the phrase mustn't split it, and a tag's own words
  // (names and values) count too, since a raw reader sees them.
  for (const [form, text] of [
    ["an anchor inside the phrase", 'Re<a href="u">view notes</a>'],
    ["a span inside the phrase", 'Rev<span class="x">iew notes'],
    ["a span in a heading", '## <span title="x">Review notes</span>'],
    ["a heading with an id", '<h2 id="notes">Review notes</h2>'],
    ["a < inside a quoted value", '<img alt="<Review notes>" src="x.png">'],
    ["words as valueless attributes", "<x Review notes>"],
    ["a tag open across a line", '<img\n  alt="Review notes">'],
  ] as const) {
    it(`reads ${form} as visible`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  it("puts the text before the attribute words, so a line that opens with the phrase starts with it", () => {
    assert.ok(visibleLetters('<h2 id="notes" class="x">Review notes</h2>').startsWith("reviewnotes"));
  });

  // Round 2: every look-alike in the tables is read as its letter, capital or not.
  for (const [letter, latin] of Object.entries(LOOK_ALIKES)) {
    it(`reads U+${letter.codePointAt(0)!.toString(16).padStart(4, "0")} as ${latin}`, () => {
      assert.equal(visibleLetters(letter), latin);
    });
  }
  for (const [letter, latin] of Object.entries(CAPITAL_LOOK_ALIKES)) {
    it(`reads capital U+${letter.codePointAt(0)!.toString(16).padStart(4, "0")} as ${latin}`, () => {
      assert.equal(visibleLetters(letter), latin);
    });
  }

  for (const [form, text] of [
    ["Greek capitals", "R\u0395VI\u0395W \u039dOTES"],
    ["Cyrillic capitals", "R\u0415VIEW N\u041eT\u0415\u0405"],
    ["Latin small capitals", "\u0280\u1d07\u1d20\u026a\u1d07\u1d21 \u0274\u1d0f\u1d1b\u1d07\ua731"],
    ["Greek lowercase epsilon", "R\u03b5view notes"],
  ] as const) {
    it(`reads the phrase in ${form}`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  it("doesn't take a Cyrillic or Greek capital that looks like P for an R", () => {
    assert.equal(visibleLetters("\u0420 \u03a1"), "\u0440\u03c1");
  });

  // R62: text in a tag's attributes, which a tooltip or a failed image shows.
  for (const [form, text] of [
    ["a double-quoted alt", '<img alt="Review notes" src="x.png">'],
    ["a single-quoted title", "<a title='Review notes'>x</a>"],
    ["an unquoted value", "<p title=reviewnotes>x</p>"],
    ["an image's alt text", "![Review notes](x.png)"],
    ["a link's title", '[x](https://example.com "Review notes")'],
  ] as const) {
    it(`reads ${form} as visible`, () => {
      assert.ok(visibleLetters(text).includes("reviewnotes"), visibleLetters(text));
    });
  }

  // R63: letters that draw nothing, and one that lowercases to two characters.
  for (const [form, text] of [
    ["a Hangul filler", "Review\u3164notes"],
    ["a halfwidth Hangul filler", "Review\uffa0 notes"],
    ["Hangul choseong and jungseong fillers", "Rev\u115f\u1160iew notes"],
    ["a dotted capital I", "Rev\u0130ew notes"],
    ["a dotless i", "Rev\u0131ew notes"],
  ] as const) {
    it(`reads ${form} as the letters a reader sees`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  // R64: HTML decodes a numeric reference with no semicolon.
  for (const [form, text] of [
    ["a decimal reference without a semicolon", "Review&#32notes"],
    ["a hexadecimal reference without a semicolon", "Re&#x76iew notes"],
    ["a reference ending the line", "Review notes&#33"],
  ] as const) {
    it(`reads ${form} as the letters a reader sees`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  // R65: letters of the phrase drawn by another script's look-alike.
  for (const [form, text] of [
    ["Cyrillic e and o", "R\u0435view n\u043et\u0435s"],
    ["Cyrillic i and s", "Rev\u0456ew note\u0455"],
    ["Greek omicron and nu", "Re\u03bdiew n\u03bfte\u0073"],
    ["Armenian n", "Review \u0578otes"],
  ] as const) {
    it(`reads ${form} as the Latin letters they look like`, () => {
      assert.equal(visibleLetters(text), "reviewnotes");
    });
  }

  it("reads an HTML comment, which shows nothing, as nothing, even across lines", () => {
    assert.equal(visibleLetters("a<!-- Review\nnotes -->b <?php hidden ?>c"), "abc");
  });

  it("reads nothing as nothing, and markup alone as nothing", () => {
    assert.equal(visibleLetters(""), "");
    assert.equal(visibleLetters("<br><hr/> ## ** &nbsp; &#33;"), "");
  });

  it("reads a character reference with leading zeros, and one for a lone surrogate or a NUL, without throwing", () => {
    assert.equal(visibleLetters("&#0118;iew&#0;&#xD800;"), "view");
  });

  it("keeps the letters of any script, since it only reads letters", () => {
    assert.equal(visibleLetters("Überprüfung 検討 Δ"), "überprüfung検討δ");
  });

  it("takes a reference to a code point that doesn't exist for nothing, rather than throw", () => {
    assert.equal(visibleLetters("a&#99999999;b&#x110000;c"), "abc");
  });
});

describe("plainText", () => {
  it("escapes a leading tilde, which would otherwise open a code fence", () => {
    assert.equal(plainText("~~~x"), "\\~~~x");
  });

  it("escapes it after leading whitespace too, and leaves a tilde elsewhere in the line alone", () => {
    assert.equal(plainText("  ~~~x"), "\\~~~x");
    assert.equal(plainText("a ~~~x"), "a ~~~x");
  });
});
