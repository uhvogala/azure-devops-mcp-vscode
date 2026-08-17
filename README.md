# Azure DevOps PRs (MCP)

This VS Code extension exposes Azure DevOps Git pull requests to agents through a local MCP server. It uses the official MCP TypeScript SDK, `azure-devops-node-api`, and VS Code's Microsoft authentication provider. No personal access token, client ID, or client secret is created, copied, or maintained.

## Use

1. Run `Azure DevOps PRs (MCP): Sign In to Azure DevOps`. VS Code opens its normal Microsoft sign-in flow when needed.
2. Start an agent conversation. VS Code discovers the `Azure DevOps pull requests` MCP server automatically.

The server provides `list_pull_requests`, `get_pull_request`, `open_pull_request_file_diff`, `create_pull_request`, and `submit_pull_request`. `create_pull_request` prepares a local draft; `submit_pull_request` creates the remote pull request and requires `confirm: true`. Both use source and target refs in `refs/heads/...` form and the caller's Azure DevOps permissions.

Pass `includeChanges: true` to `get_pull_request` to return its latest changed files, including commit IDs and change types. In MCP Apps-capable chat hosts, `create_pull_request` opens an editable draft card with a compact, capped list of changed files. It offers a Markdown preview switch and submits the final description text through `submit_pull_request`; the resulting pull request then becomes the interactive review card with current reviewer votes, an **Approve PR** button, clickable comment counts, and an **Open diff** button for every changed file. A spinner is shown while the card loads or performs an action.

VS Code manages the signed-in Microsoft session. Manage or sign out of that account through VS Code's Accounts menu. Start a new agent conversation when a token expires to obtain a fresh Azure DevOps token.

## Development

Run `npm run compile` to type-check, lint, and bundle both the extension and the MCP server. Run `npm test` to execute the extension-host tests. On macOS, the test command uses System keychain certificates when a managed network requires an additional trusted CA. Press `F5` in VS Code to launch an Extension Development Host.
