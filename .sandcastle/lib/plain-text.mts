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

// Letters that draw like the Latin ones of "Review notes" (R, e, v, i, w, n,
// o, t, s) and that NFKC leaves alone: from other scripts, and a few Latin
// ones (the dotless i, the small capitals). Only those nine letters: no list
// of every look-alike could be complete. The lowercase table is applied
// after lowercasing, the capitals one before it, since a capital Greek Nu
// lowercases to a nu, which looks like a v. Cyrillic and Greek capitals that
// look like P or B aren't here: the phrase has neither.
export const LOOK_ALIKES: Record<string, string> = {
  "\u0131": "i", "\u0435": "e", "\u043e": "o", "\u0456": "i", "\u0455": "s", "\u0433": "r", "\u0442": "t",
  "\u03b5": "e", "\u03bf": "o", "\u03bd": "v", "\u03b9": "i", "\u03c4": "t", "\u03c9": "w",
  "\u0475": "v", "\u051d": "w", "\u0578": "n", "\u057c": "n", "\u0585": "o",
  "\u0280": "r", "\u1d07": "e", "\u1d20": "v", "\u026a": "i", "\u1d21": "w", "\u0274": "n", "\u1d0f": "o", "\u1d1b": "t", "\ua731": "s",
};
export const CAPITAL_LOOK_ALIKES: Record<string, string> = {
  "\u0395": "e", "\u039d": "n", "\u0399": "i", "\u039f": "o", "\u03a4": "t",
  "\u0415": "e", "\u041e": "o", "\u0422": "t", "\u0406": "i", "\u0405": "s", "\u051c": "w",
};
const fold = (text: string, table: Record<string, string>) => [...text].map((letter) => table[letter] ?? letter).join("");

// Raw HTML that draws nothing: a comment, declaration or processing
// instruction (the comment's own text may span lines; `<!-->` and `<!--->`
// close at once, as in HTML).
const HIDDEN_MARKUP = /<!--(?:-?>|[\s\S]*?--!?>)|<[!?][^>]*>/g;

// A tag as CommonMark reads it: a name, attributes that are a name and an
// optional value (a quoted one may hold anything but a blank line), and no
// blank line inside; whitespace is space, tab and a line ending, not a
// no-break space. Anything else that starts with `<`, a stray `<`, a generic
// type, an autolink, is text a reader sees.
const WS = String.raw`(?:[ \t]|\n(?![ \t]*\n))`;
const QUOTED = (quote: string) => String.raw`${quote}(?:[^${quote}\n]|\n(?![ \t]*\n))*${quote}`;
const TAG = new RegExp(
  String.raw`<\/[a-z][a-z0-9-]*${WS}*>|<[a-z][a-z0-9-]*(?:${WS}+[a-z_:][\w.:-]*(?:${WS}*=${WS}*(?:[^\s"'=<>\x60]+|${QUOTED("'")}|${QUOTED('"')}))?)*${WS}*\/?>`,
  "gi",
);
// The values a reader can see: an image's alt text and a tooltip (title), not
// a src or href, which would run into the words round them.
const attributeValues = (tag: string) =>
  [...tag.matchAll(/(?<![\w:.-])(?:alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .join(" ");

// The letters of `text` as one reader sees them: character references decoded
// (with or without the semicolon, as HTML does) and named ones dropped,
// compatibility forms folded (NFKC), characters that draw nothing (Hangul
// fillers and other default-ignorable code points) removed, look-alikes of the
// phrase's letters mapped to them, lowercased, and everything that isn't a
// letter dropped (spaces, punctuation, emphasis and code marks, format and
// combining characters).
function letters(text: string): string {
  const folded = fold(
    text
      .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => character(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);?/g, (_, decimal: string) => character(Number(decimal)))
      .replace(/&[a-z][a-z0-9]*;/gi, " ")
      .normalize("NFKC")
      .replace(/\p{Default_Ignorable_Code_Point}/gu, ""),
    CAPITAL_LOOK_ALIKES,
  )
    // Lowercased before the non-letters go: a dotted capital I lowercases to
    // an i and a combining dot, which NFKC doesn't compose.
    .toLowerCase()
    .normalize("NFKC");
  return fold(folded, LOOK_ALIKES).replace(/[^\p{L}]+/gu, "");
}

// The letters a reader sees in Markdown `text`, run together, once for each
// way a reader may see it, separated by spaces (one reading when they agree):
// the raw text, where a tag's name and attributes are words a raw reader
// sees (`<Review notes>`, which GitHub prints as text in a code span too);
// with each tag drawn as nothing, so a tag inside the phrase doesn't split it;
// and with each tag replaced by its alt text and title, which show as an
// image's alt text or a tooltip. A hidden comment is dropped from all three.
// So `## Re*view*&#32;**notes**` reads "reviewnotes", as it renders. A link's
// destination and title stay in: over-reading only refuses more. A named
// reference without its semicolon is left alone: where its name ends can't be
// told, so build.mts refuses it. Test for a phrase with `includes` (or, for a
// line's start, `startsWith` on each space-separated reading).
export function visibleLetters(text: string): string {
  const shown = text.replace(HIDDEN_MARKUP, "");
  const readings = [shown, shown.replace(TAG, ""), shown.replace(TAG, (tag) => ` ${attributeValues(tag)} `)];
  return [...new Set(readings.map(letters))].join(" ");
}
