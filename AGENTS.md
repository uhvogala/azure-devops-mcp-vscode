# Agent Guidance

Before using any Azure DevOps MCP tool, run `Azure DevOps PRs (MCP): Sign In to Azure DevOps` and complete VS Code's Microsoft sign-in flow. Do not attempt pull request, draft, review, checkout, or comment operations until sign-in succeeds.

When the Azure DevOps organization, project, or repository is unknown, call `get_workspace_repositories` once. Prefer its `activeRepository`; otherwise use the returned workspace repository list rather than searching files or manually parsing Git remotes.

When a user asks to show, open, view, or review a specific pull request, call `get_pull_request` directly. It renders the interactive review card. Use `list_pull_requests` only when the pull request ID is unknown.

Use `create_pull_request` to prepare a local editable draft. It does not create a remote pull request. Only `submit_pull_request` creates the remote PR and requires `confirm: true`.

Run `npm test` before completing extension changes. Package with `npx vsce package` after a version bump when a local install or release artifact is needed.
