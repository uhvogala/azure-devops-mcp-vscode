# Azure DevOps PRs (MCP)

This VS Code extension exposes Azure DevOps Git pull requests to agents through a local MCP server. It uses the official MCP TypeScript SDK, `azure-devops-node-api`, and VS Code's Microsoft authentication provider. No personal access token, client ID, or client secret is created, copied, or maintained.

## Use

Before asking an agent to use this extension, run `Azure DevOps PRs (MCP): Sign In to Azure DevOps`. Complete VS Code's Microsoft sign-in flow first; the MCP server cannot access Azure DevOps until this session is available.

Then start an agent conversation. VS Code discovers the `Azure DevOps pull requests` MCP server automatically.

The server provides `list_pull_requests`, `get_pull_request`, `open_pull_request_file_diff`, `create_pull_request`, and `submit_pull_request`. `create_pull_request` prepares a local draft; `submit_pull_request` creates the remote pull request and requires `confirm: true`. Both use source and target refs in `refs/heads/...` form and the caller's Azure DevOps permissions.

When an agent does not yet know the Azure DevOps organization, project, or repository, it should call `get_workspace_repositories`. The response includes every Azure DevOps repository in the open workspace and identifies the active editor repository when available, avoiding repository text searches and manual remote parsing.

`get_pull_request` includes changed files by default and renders an interactive review card in MCP Apps-capable chat hosts. `create_pull_request` creates a local editable draft card with a Markdown preview, changed-file list, and submit action. Draft descriptions synchronize across open cards. The Activity Bar provides active pull requests, local draft selection, review actions, draft deletion, and the same draft editor. Submitting creates the remote pull request; deleting a draft only removes its local shared state.

VS Code manages the signed-in Microsoft session. Manage or sign out of that account through VS Code's Accounts menu. Start a new agent conversation when a token expires to obtain a fresh Azure DevOps token.

## Development

Run `npm run compile` to type-check, lint, and bundle both the extension and the MCP server. Run `npm test` to execute the extension-host tests. On macOS, the test command uses System keychain certificates when a managed network requires an additional trusted CA. Press `F5` in VS Code to launch an Extension Development Host.
