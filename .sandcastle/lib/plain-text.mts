// Untrusted text (an agent's or a reviewer's words, an issue title) made safe
// to post on GitHub, and Markdown read as a reader sees it (visibleLetters,
// which lib/build.mts and lib/review-ledger.mts use to refuse text that reads
// "Review notes"). Kept apart from lib/intake.mts so a command-line tool,
// lib/review-ledger.mts, can use it without loading Sandcastle.

// A zero-width space after @, a # or GH- before digits, and the dot of
// github.com, so none mentions anyone or links another issue or PR.
export function breakReferences(text: string): string {
  return text
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200B")
    .replace(/#(?=\d)/g, "#\u200B")
    .replace(/\b(GH)-(?=\d)/gi, "$1-\u200B")
    .replace(/\b(github)\.(com)\b/gi, "$1\u200B.$2");
}

// Untrusted `text` as one line of plain Markdown for a GitHub comment or
// description: intake's words to an issue's author, a follow-up reply, the
// local review's report and Review notes. Nothing in it may restructure the
// comment or reach anyone else (intake's #224 and #227 were cases): it's
// kept to one line; backslashes and backticks are escaped (no code span or
// fence to swallow the re-queue instructions), and so are & (no character
// reference to decode into an @, # or . that breakReferences doesn't see) and
// < (no HTML tag, such as an unclosed <details>, or comment to hide them);
// mentions and cross-references are broken (see breakReferences); and a
// leading Markdown marker is escaped so it can't start a list, heading, quote
// or ~~~ code fence.
export function plainText(text: string): string {
  return breakReferences(
    text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\\`]/g, "\\$&")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;"),
  )
    .replace(/^[-+*#>~]/, "\\$&")
    .replace(/^(\d+)([.)])(?=\s)/, "$1\\$2");
}

// A code point as text, or nothing for one that isn't a character.
const character = (codePoint: number) => (codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "");

// Letters from other scripts that draw like the Latin ones of "Review notes"
// (R, e, v, i, w, n, o, t, s), which NFKC leaves alone. Only those nine
// letters: no list of every look-alike could be complete.
const LOOK_ALIKES: Record<string, string> = {
  "\u0131": "i", "\u0435": "e", "\u043e": "o", "\u0456": "i", "\u0455": "s", "\u0433": "r", "\u0442": "t",
  "\u03bf": "o", "\u03bd": "v", "\u03b9": "i", "\u03c4": "t", "\u0475": "v", "\u051d": "w", "\u0578": "n", "\u057c": "n",
  "\u0585": "o", "\u03c9": "w",
};

// A real tag (`<b>`, `</b>`, `<br/>`, `<a title="x">`) is replaced by the
// letters of its attribute values: a stray `<` and `>` far apart aren't one,
// and the values can show as a tooltip or an image's alt text.
// An HTML comment, declaration or processing instruction shows nothing (the
// comment's own text may span lines, as in HTML).
const HIDDEN_MARKUP = /<!--[\s\S]*?-->|<[!?][^>]*>/g;
const TAG = /<\/?[a-z][^<>]*>/gi;
const attributeValues = (tag: string) =>
  [...tag.matchAll(/=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)].map((match) => ` ${match[1] ?? match[2] ?? match[3]} `).join("");

// The letters a reader sees in Markdown `text`, lowercased and run together:
// HTML comments dropped, real tags dropped but their attribute values kept, numeric character
// references decoded (with or without the semicolon, as HTML does) and named
// ones dropped, compatibility forms folded (NFKC), characters that draw
// nothing (Hangul fillers and other default-ignorable code points) removed,
// the look-alikes of the phrase's letters mapped to them, and everything that
// isn't a letter dropped (spaces, punctuation, emphasis and code marks,
// format and combining characters). So `## Re*view*&#32;**notes**` reads
// "reviewnotes", as it renders. A link's destination and title and an image's
// alt text stay in: over-reading only refuses more.
export function visibleLetters(text: string): string {
  const folded = text
    .replace(HIDDEN_MARKUP, "")
    .replace(TAG, attributeValues)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => character(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, decimal: string) => character(Number(decimal)))
    .replace(/&[a-z][a-z0-9]*;/gi, " ")
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    // Lowercased before the non-letters go: a dotted capital I lowercases to
    // an i and a combining dot, which NFKC doesn't compose.
    .toLowerCase()
    .normalize("NFKC");
  return [...folded].map((letter) => LOOK_ALIKES[letter] ?? letter).join("").replace(/[^\p{L}]+/gu, "");
}
