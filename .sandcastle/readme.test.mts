import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const lines = readme.split("\n");

const ALL_RELEASES_LINK = "[All releases →](https://github.com/mpaulosky/auth0-management-app/releases)";
const ANCHOR = "releases-and-blog-posts";
const POINTER = `How Releases are cut: see [Releases and blog posts](#${ANCHOR}).`;
const pointerLine = lines.indexOf(POINTER);

// GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens.
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

describe("README.md Releases section", () => {
  it("puts the how-Releases-are-cut line after the All releases link", () => {
    const linkLine = lines.indexOf(ALL_RELEASES_LINK);

    assert.notEqual(linkLine, -1, "README.md has no All releases link line");
    assert.notEqual(pointerLine, -1, "README.md has no how-Releases-are-cut line");
    assert.ok(pointerLine > linkLine, "the line must come after the All releases link");
  });

  it("keeps the line in the Releases section, before the next heading", () => {
    const releasesHeading = lines.indexOf("## Releases");
    assert.notEqual(releasesHeading, -1, "README.md has no ## Releases heading");
    // Without a later heading, the section runs to the end of the file.
    const next = lines.findIndex((line, i) => i > releasesHeading && line.startsWith("## "));
    const nextHeading = next === -1 ? lines.length : next;

    assert.notEqual(pointerLine, -1, "README.md has no how-Releases-are-cut line");
    assert.ok(pointerLine > releasesHeading && pointerLine < nextHeading, "the line must sit inside ## Releases");
  });

  it("keeps the line outside the generated RELEASES block", () => {
    const start = lines.indexOf("<!-- RELEASES_START -->");
    const end = lines.indexOf("<!-- RELEASES_END -->");

    assert.notEqual(pointerLine, -1, "README.md has no how-Releases-are-cut line");
    assert.ok(start !== -1 && end > start, "README.md lost its RELEASES_START/END markers");
    assert.ok(pointerLine > end, "the line must come after RELEASES_END, outside the regenerated block");
  });

  it("links to an anchor that resolves to the Releases and blog posts heading", () => {
    const headingSlugs = lines.filter((line) => /^#{1,6} /.test(line)).map((line) => slug(line.replace(/^#+ /, "")));

    assert.notEqual(pointerLine, -1, "README.md has no how-Releases-are-cut line");
    assert.ok(lines.includes("## Releases and blog posts"), "README.md has no Releases and blog posts heading");
    assert.ok(headingSlugs.includes(ANCHOR), `no heading resolves to #${ANCHOR}`);
  });
});
