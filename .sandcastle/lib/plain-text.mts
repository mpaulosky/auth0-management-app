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

// The letters a reader sees in Markdown `text`, lowercased and run together:
// HTML tags dropped, numeric character references decoded and named ones
// dropped, compatibility forms folded (NFKC), and everything that isn't a
// letter dropped (spaces, punctuation, emphasis and code marks, format and
// combining characters). So `## Re*view*&#32;**notes**` reads "reviewnotes",
// as it renders. Letters that only look alike, from another script, aren't
// folded.
export function visibleLetters(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => character(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => character(Number(decimal)))
    .replace(/&[a-z][a-z0-9]*;/gi, " ")
    .normalize("NFKC")
    .replace(/[^\p{L}]+/gu, "")
    .toLowerCase();
}
