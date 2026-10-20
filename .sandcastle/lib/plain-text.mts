// Untrusted text (an agent's or a reviewer's words, an issue title) made safe
// to post on GitHub. Kept apart from lib/intake.mts so a command-line tool,
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
// leading Markdown marker is escaped so it can't start a list, heading or
// quote.
export function plainText(text: string): string {
  return breakReferences(
    text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\\`]/g, "\\$&")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;"),
  )
    .replace(/^[-+*#>]/, "\\$&")
    .replace(/^(\d+)([.)])(?=\s)/, "$1\\$2");
}

