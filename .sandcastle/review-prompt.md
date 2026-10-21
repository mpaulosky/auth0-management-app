# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality.

# CONTEXT

## The issue

Issue #{{TASK_ID}}: {{ISSUE_TITLE}}

<issue>

{{ISSUE_BODY}}

</issue>

Comments on the issue from the repository owner:

<issue-comments>

{{ISSUE_COMMENTS}}

</issue-comments>

## Branch diff

!`git diff {{BASE_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{BASE_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, null-forgiving operators, or unchecked assumptions?
   - Does it follow the red → green history the issue asks for, with tests covering every new or changed behaviour?
   - Do the acceptance tests cover every acceptance criterion in the issue that can be tested automatically? The tester committed them red first. Name any criterion no test
     checks. A criterion that can't be tested automatically, such as one about docs or a manual step, needs no test: check it against the change directly.
   - Did the developers weaken the tester's tests to make them pass? Compare each acceptance test with the tester's commit: look for removed or loosened assertions, tests that
     were skipped, commented out or deleted, and expected values changed to match the code.
   - When `.sandcastle/work/{{TASK_ID}}/design.md` exists, was the architect's design note followed? Where the code departs from it, is the difference explained in a commit
     body? Name any unexplained difference in your final message rather than change the code to match the note.
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the coding standards defined in @docs/CODING_STANDARDS.md

6. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

# EXECUTION

A missing acceptance test, or one that was weakened, is the one exception to preserving functionality: add the missing test for a criterion that can be tested automatically, or
restore what the tester's test checked, and commit it with `test(<scope>): <Summary>`. If the code then fails the test, don't change the test to match it. Say in the commit body what fails.

If you find improvements to make:

1. Make the changes directly on this branch
2. Commit using `refactor(<scope>): <Summary>`
3. Run `scripts/gate.sh` as your last step and confirm it passes

If the code is already clean and well-structured, change nothing.

Either way, write the PR description last, once the branch is final, to `.sandcastle/work/{{TASK_ID}}/pr-body.md`, creating the folder. It's gitignored, so don't commit it:
the host reads it after your run and publishes it as the PR's body, under its own marker and `Closes #{{TASK_ID}}`. The description is published as written, apart from the
references the host breaks (below), as the squash
commit's message, the Release's notes and the release blog post, so follow "The PR description" in `docs/PROCESS.md` and write it for a reader who wasn't there, in plain
sentences. Use exactly these three headings, in this order, and no others at that level:

```markdown
## Why

## What changed

## Verification
```

- **Why**: the problem the issue describes and who it affects, in a few sentences.
- **What changed**: what the branch does, as a short list a reader can check against the diff. Name any departure from the design note.
- **Verification**: the tests added or changed, by file and what they pin, and the gate checkpoints the branch passed. Claim only checks this run made or the commits record:
  never a manual test, a real-sandbox run or a CI result nobody ran.
- Never write a `<` directly followed by an exclamation mark or a question mark, a closing bracket directly followed by a colon, a character reference (an ampersand and a word and
  a semicolon, an ampersand and a hash sign, or an ampersand followed by a legacy name such as `&nbsp`, `&not` or `&sect`, in any case, even at the start of a longer word such
  as `&section`; a plain ampersand, as in `R&D`, or a query string inside a link, is fine), or any of
  these tags, opening or closing: `<script>`, `<style>`, `<noscript>`, `<template>`, `<textarea>`, `<iframe>`, `<svg>`, `<math>`, `<xmp>`, `<plaintext>`, `<noembed>`, `<noframes>`.
  Not even in backticks or a code block: describe them in words.
  Never write the words "Review notes" either, in any form. The host joins every letter of the description, ignoring spaces, punctuation and line breaks, and refuses it
  wherever "review" is followed by "notes": run together, inside a name such as `renderReviewNotes`, inside a word such as "preview notes", or across a sentence ("the
  review. Notes"). Name the file or describe the function instead, or keep the two words apart with another word. The join reads HTML attribute values, link titles and image
  alt text too, drops letters that draw nothing, and takes look-alike letters for the Latin ones. Write plain English: the host refuses any character but ASCII, Latin letters
  with accents (but no no-break space), and a few marks (dashes, curly quotes, an ellipsis, arrows, comparisons, check marks), so no emoji or other scripts.
  The host refuses a description with any of these and publishes its generic one: it adds its own HTML-comment marker, Review notes hold a person's accepted findings,
  which only their local review writes, and nothing published may be hidden from the people reading it.
  The host does not refuse mentions and issue references but breaks them: every at sign before a letter or digit, every hash sign or GH- before a digit, and the dot of every
  github.com gets an invisible character, even in code and links, so a `Closes` would not close and a mention would not notify. Describe a Razor directive such as page, inject or
  rendermode in words, since quoted it would not copy as written, and don't link to GitHub.

Don't add `Closes`, `Fixes`, a marker or a sign-off line: the host adds what it needs. Never put a secret, a token or a credential in it. When the file is missing, lacks a heading,
is too long, holds anything the bullet above refuses or looks like it holds a secret, the host publishes a generic body instead.

Once the description is written, output <promise>COMPLETE</promise>.

# RULES

{{SHARED_RULES}}
