# Change Log

All notable changes to the "azure-devops-prs-mcp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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