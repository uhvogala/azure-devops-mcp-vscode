# Change Log

All notable changes to the "azure-devops-prs-mcp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.80]

- Split card rendering from quiet pull request reads to prevent empty or unintended MCP App views.
- Add `get_pull_request_summary` for JSON-only inspection, reloads, and mutation verification.

## [0.0.79]

- Refresh active review cards when any displayed pull request content changes, including title, description, status, target branch, reviewers, and work-item details.

## [0.0.78]

- Add `update_pull_request` for confirmed title, description, and target-branch edits to active pull requests.

## [0.0.77]

- Match the chat review root layout to the Activity Bar by removing its chat-only outer panel.

## [0.0.76]

- Restore the chat card's two-tone hierarchy by using the chat surface around the widget card.

## [0.0.75]

- Match the chat card document canvas to the card surface to remove its visible dark frame.

## [0.0.74]

- Let chat pull request cards use the full host width and keep compact file actions inside their rows.

## [0.0.73]

- Use one theme-aware stylesheet for chat and Activity Bar pull request cards, including compact changed-file rows.

## [0.0.72]

- Support work-item discovery and linking across authorized Azure DevOps projects.
- Show linked work items in chat and Activity Bar pull request review cards with browser links to Azure DevOps work-item pages.
- Prompt agents to offer optional work-item linking when it improves pull request traceability.
- Derive MCP runtime versions from package metadata and keep the review-card resource URI stable.

## [0.0.71]

- Add MCP tools to query project work items, inspect pull request work-item links, and link approved work items when creating or updating a pull request.

## [0.0.70]

- Refresh Azure DevOps access tokens from the active VS Code Microsoft session so expired MCP credentials recover without reloading VS Code.

## [0.0.69]

- Redesign pull request review cards with VS Code-native surfaces, compact approval rows, and inline checkoutable branch links.

## [0.0.68]

- Keep Activity Bar loading status within the selected repository row.
- Compact changed-file rows into stable review, metadata, and icon-action columns at all widths.

## [0.0.67]

- Center deleted, submitted, and no-selection status messages in pull request cards.

## [0.0.66]

- Use Azure DevOps `heads/...` ref filters when loading draft changed files.

## [0.0.65]

- Load only the selected source and target refs when preparing draft changed files.

## [0.0.64]

- Show Activity Bar loading feedback while selecting repositories and pull requests, and select a workspace repository by default.
- Show complete changed-file paths on hover and render comments positioned on either diff side.
- Mark submitted draft cards as submitted instead of deleted.
- Guide agents to reuse existing sign-in sessions and obtain text-review confirmation before submission.

## [0.0.63]

- Compare pull request and draft changes from the Git merge base so target-only commits do not appear as PR changes.

## [0.0.62]

- Wait for Git repository initialization before loading Activity Bar pull request views.
- Show the current local branch on checkout controls when review cards first open.

## [0.0.61]

- Keep checkout buttons synchronized with the current local Git branch after card refreshes.

## [0.0.60]

- Fix Git repository state subscriptions so the Activity Bar views activate correctly.

## [0.0.59]

- Require VS Code's built-in Git extension for repository discovery, checkout, and local pull request refreshes.
- Remove duplicate Git subprocess fallback paths.

## [0.0.58]

- Use VS Code's Git API for workspace repository discovery, local repository refresh identity, and pull request branch checkout when available.

## [0.0.57]

- Refresh open pull request cards immediately after local Git repository changes, while retaining the remote-push polling fallback.

## [0.0.56]

- Exclude folder entries from changed-file cards.
- Refresh open pull request cards when the source or target branch advances.
- Transition submitted drafts directly to their live pull request card.

## [0.0.55]

- Show the complete source-versus-target file comparison in pull request cards, including changes from earlier PR iterations.

## [0.0.54]

- Improve Marketplace discovery with Azure and SCM categories, targeted search keywords, and a clearer extension description.

## [0.0.53]

- Add one-call workspace Azure DevOps repository discovery for agents.
- Guide agents to use the active workspace repository before repository-scoped pull request tools.

## [0.0.52]

- Center file-row details and actions in review cards.
- Clarify sign-in prerequisites in user and agent guidance.
- Refresh documentation for interactive cards, shared drafts, and Activity Bar workflows.

## [0.0.51]

- Add Activity Bar draft management beneath the active pull request list.
- Reuse the editable draft card across chat and the Activity Bar.
- Synchronize local draft descriptions and add draft deletion from cards and the native list.
- Add revisioned shared state for synchronized reviewed-file status and future card state.
- Improve interactive card guidance, styling, and file-row alignment.
- Add Marketplace metadata, MIT license, GitHub Actions CI, and tag-triggered release packaging.

## [0.0.2]

- Use VS Code's Microsoft authentication provider for Azure DevOps user sign-in.
- Remove Microsoft Entra client ID and tenant configuration requirements.
- Remove extension-managed MSAL token caching.

## [0.0.1]

- Initial release.