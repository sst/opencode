<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts. The body below becomes the skill's
  content.
-->

# Report an opencode Issue

Use this skill when the user wants to report an opencode issue or bug. Your job
is to turn the user's problem into a useful GitHub issue with standard
diagnostics plus the context needed to reproduce and resolve it.

## Workflow

1. Collect the standard diagnostics below.
2. Ask only for missing details that are necessary to reproduce or understand
   impact.
3. Draft the issue in the standard format below.
4. Publish it with GitHub CLI after the user confirms the title and body.

Do not publish an issue without user confirmation. If GitHub CLI is not
installed or not authenticated, explain the blocker and provide the exact issue
title/body for the user.

## Standard Diagnostics

Collect these values when possible:

- opencode version: run `opencode --version`.
- Operating system: run `uname -a` on Unix-like systems, or `ver` on Windows.
- Terminal: inspect `$TERM`, `$TERM_PROGRAM`, `$COLORTERM`, and any obvious
  terminal app context the user provides.
- Shell: inspect `$SHELL` on Unix-like systems, or `%COMSPEC%`/`$ComSpec` on
  Windows when relevant.
- Install/channel context: include whether this appears to be local, dev, beta,
  or release if the version output or environment reveals it.
- Active plugins: inspect opencode config for configured plugins when possible.
  Check likely config locations such as `opencode.json`, `opencode.jsonc`,
  `.opencode/opencode.json`, and `~/.config/opencode/opencode.json`. Record
  configured plugin entries, local plugin files under `.opencode/plugin/` or
  `.opencode/plugins/`, and note if plugin status could not be determined.

If a diagnostic command fails, include `Unavailable` with the reason instead of
guessing.

## User-Specific Context

Capture the details that make the issue actionable:

- What the user was trying to do.
- What happened.
- What the user expected to happen.
- Reproduction steps, ideally minimal and numbered.
- Relevant logs, stack traces, screenshots, terminal output, or config snippets.
- Whether the issue is reproducible consistently, intermittently, or only once.
- Recent changes that may be related, such as updating opencode, changing
  config, installing a plugin, changing terminal, or switching workspace.
- Workarounds tried and whether they helped.

Avoid pasting secrets. Redact tokens, API keys, private URLs, usernames, and
project-specific confidential data unless the user explicitly says it is safe.

## Issue Format

Use this exact structure unless the repository issue template requires
otherwise:

```markdown
## Summary

<!-- One or two sentences describing the bug and impact. -->

## Environment

- opencode version: <!-- value or Unavailable: reason -->
- OS: <!-- value or Unavailable: reason -->
- Terminal: <!-- value or Unavailable: reason -->
- Shell: <!-- value or Unavailable: reason -->
- Install/channel: <!-- value or Unavailable: reason -->
- Active plugins: <!-- list, none found, or Unavailable: reason -->

## Reproduction

1. <!-- step -->
2. <!-- step -->
3. <!-- step -->

## Expected Behavior

<!-- What should have happened. -->

## Actual Behavior

<!-- What happened instead. Include exact errors when available. -->

## Additional Context

<!-- Logs, config snippets, screenshots, frequency, workarounds, related notes. -->
```

Keep the title short and searchable. Prefer the form:

```text
<area>: <specific failure or symptom>
```

Examples: `tui: skills dialog crashes outside location provider`,
`cli: local service config writes release filename`.

## Publishing With GitHub CLI

Use GitHub CLI from the repository checkout when available:

```sh
gh issue create --title "<title>" --body-file <file>
```

Write the body to a temporary markdown file first so quoting, newlines, logs,
and code fences are preserved. If the issue belongs in a specific repository,
use `--repo owner/name`. If labels are obvious and the repo accepts them, add
`--label bug`; otherwise omit labels rather than guessing.

After publishing, report the created issue URL to the user and mention any
diagnostics that were unavailable.
