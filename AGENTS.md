# Agent Guidance

VS Code reuses the existing Microsoft session for Azure DevOps MCP tools. Do not run `Azure DevOps PRs (MCP): Sign In to Azure DevOps` routinely; ask the user to complete sign-in only when an operation reports missing or expired authentication.

Keep VS Code's built-in Git extension enabled. This extension uses its repository API for workspace discovery, checkout, and local pull request refreshes.

When the Azure DevOps organization, project, or repository is unknown, call `get_workspace_repositories` once. Prefer its `activeRepository`; otherwise use the returned workspace repository list rather than searching files or manually parsing Git remotes.

When a user asks to show, open, view, or review a specific pull request, call `get_pull_request` directly. It renders the interactive review card. Use `list_pull_requests` only when the pull request ID is unknown.

Use `create_pull_request` to prepare a local editable draft. It does not create a remote pull request. Present the draft for the user to edit, ask whether they want any text changes, and wait for explicit confirmation before using `submit_pull_request`, which creates the remote PR and requires `confirm: true`.

Run `npm test` before completing extension changes. Package with `npx vsce package` after a version bump when a local install or release artifact is needed.
