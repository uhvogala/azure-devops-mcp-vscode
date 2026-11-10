# Azure DevOps PRs and Pipelines for VS Code (MCP)

[![MCP Enabled](https://img.shields.io/badge/MCP-Enabled-orange.svg)](https://modelcontextprotocol.io/)

Review, draft, and check out Azure DevOps pull requests, and run, edit, and monitor CI pipelines directly in GitHub Copilot Chat and VS Code AI Agents, without personal access tokens or API keys.

## See It in Action

### Create a Pull Request

![Create an Azure DevOps pull request with Copilot Chat](ado_mcp_1.gif)

### Review a Pull Request

![Review an Azure DevOps pull request with Copilot Chat](ado_mcp_2.gif)

## Key Features

- **Zero-configuration authentication:** Uses your existing VS Code Microsoft sign-in session. No personal access tokens, client IDs, client secrets, or credentials stored on disk.
- **Interactive pull request reviews:** Open a PR as an interactive review card with approvals, branches, changed files, comment counts, review state, and native VS Code actions.
- **Native diff and comments:** Open changed files in VS Code's native diff editor, create line comments, and reply to Azure DevOps discussion threads.
- **Smart PR drafts:** Let an agent prepare a local draft with a title, Markdown description, changed-file list, and reviewers before any remote change is made.
- **Automatic workspace discovery:** Finds Azure DevOps repositories in the open workspace and identifies the active repository when possible.
- **Branch checkout:** Check out a pull request source or target branch from the review card or through an agent.
- **CI pipeline tools:** Find YAML and classic pipelines, queue and cancel runs, inspect job progress and logs, and edit definition settings or Azure Repos pipeline YAML with explicit confirmation and conflict checks.
- **Shared live state:** Review cards and the Activity Bar stay synchronized as files are reviewed, drafts change, or comments are added.

## Quick Start

1. Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=aitostack.azure-devops-prs-mcp), or run:

	```bash
	code --install-extension aitostack.azure-devops-prs-mcp
	```

2. Open a folder containing an Azure DevOps Git repository. Keep VS Code's built-in Git extension enabled.

3. Open GitHub Copilot Chat or another MCP-compatible agent host. VS Code discovers the local `Azure DevOps pull requests and pipelines` MCP server automatically.

4. The extension reuses your existing Microsoft session. If a requested MCP tool needs a new session, complete the Microsoft sign-in flow that VS Code opens; the waiting command resumes automatically. You can also run **Azure DevOps PRs (MCP): Sign In to Azure DevOps** from the Command Palette.

## Example Prompts

| Action | Example prompt |
| --- | --- |
| List PRs | `Show me all open pull requests assigned to me in this repository.` |
| Review a PR | `Summarize the changes and active comments on PR #1042.` |
| Inspect a diff | `Open the diff for src/authentication.ts in PR #1042.` |
| Add a comment | `Add a comment on line 42 of src/authentication.ts in PR #1042: Please handle an expired token here.` |
| Draft a PR | `Create a pull request draft for my current branch targeting main.` |
| Find work items | `Find active work items whose title mentions authentication recovery.` |
| Link work items | `Link work items 1234 and 5678 to PR #1042.` |
| Check out a branch | `Check out the source branch for PR #847 locally.` |
| Inspect PR CI | `Show the pipeline runs for PR #847 and explain the failed job.` |
| Run CI | `Run pipeline 42 on my current branch with the Release configuration.` |
| Monitor a run | `Check run 1234 and show the failing task's log.` |
| Edit a pipeline | `Read pipeline 42's YAML on my PR branch and propose a fix for its test step.` |

## MCP Tools

The extension runs a local [Model Context Protocol](https://modelcontextprotocol.io/) server that gives agents access to these capabilities:

The server advertises **Azure DevOps PRs and Pipelines** in its MCP initialization response and includes structured agent instructions for discovery, PR reviews and drafts, work items, pipeline diagnosis, execution, and editing. These instructions and the tool catalog are available before Azure DevOps sign-in; agents do not need to read repository files or configure separate instructions to discover pipeline support. Tool descriptions include the next tool to call, ID meanings, pagination, log bounds, and confirmation requirements.

Use `get_pull_request` only when the user asks to display a pull request: it always opens an interactive review card. Use `get_pull_request_summary` for quiet inspection, reloads, and verification after a mutation; it returns JSON without opening a card. `update_pull_request` also returns JSON only, so existing cards refresh through their normal polling cycle rather than opening a duplicate card.

Explicit MCP tool calls can start Microsoft sign-in when silent session recovery fails. Concurrent calls share one sign-in attempt, and commands still waiting for authentication resume after sign-in succeeds, including sign-in started from the notification. Cancelled or timed-out sign-in returns an error instead of leaving commands pending. Failed operations are not automatically replayed.

Background refreshes never open interactive sign-in. When authentication is unavailable, the extension shows one actionable sign-in notification every fifteen minutes at most. Agents must not invoke the Sign In command or repeatedly retry authentication failures. Silent session lookups time out after ten seconds, interactive sign-in after forty-five seconds, and MCP token-bridge requests after sixty seconds.

| Tool | Purpose |
| --- | --- |
| `get_workspace_repositories` | Discover Azure DevOps repositories in the current workspace. |
| `list_pull_requests` | List active, completed, abandoned, or all pull requests. |
| `get_pull_request` | Show a pull request as an interactive review card with changed files. |
| `get_pull_request_summary` | Read a pull request as JSON without opening an interactive card. |
| `open_pull_request_file_diff` | Open a changed file in VS Code's native diff editor. |
| `open_pull_request_file` | Open the matching local workspace file. |
| `list_pull_request_comments` | List discussion threads and their file and line locations. |
| `add_pull_request_comment` | Create a general or line-level Azure DevOps comment. |
| `reply_to_pull_request_comment` | Reply to an existing discussion thread. |
| `approve_pull_request` | Approve a pull request as the signed-in user. |
| `checkout_pull_request_branch` | Check out a pull request source or target branch locally. |
| `set_pull_request_file_reviewed` | Mark a changed file as reviewed or not reviewed. |
| `list_pull_request_work_items` | List work items already linked to a pull request. |
| `query_work_items` | Query project work items with agent-defined WIQL filters and ordering, returning credentialed descriptions, acceptance criteria, and repro steps when available. |
| `link_pull_request_work_items` | Link selected work items to an existing pull request after explicit confirmation. |
| `create_pull_request` | Prepare an editable local pull request draft without creating a remote PR. |
| `submit_pull_request` | Create a remote pull request after explicit confirmation, optionally linking work items. |
| `update_pull_request` | Update an active pull request's title, description, or target branch after explicit confirmation, without opening a new card. |
| `list_pipelines` | Discover YAML and classic pipeline definitions, optionally scoped to a repository or name. |
| `get_pipeline` | Read pipeline settings, revision, repository, YAML path, and redacted variables. |
| `list_pipeline_runs` | Find recent CI runs by pipeline, branch, PR merge ref, or status, with pagination. |
| `get_pipeline_run` | Read a run's status, result, timeline, issues, and task log IDs. |
| `get_pipeline_run_log` | List a run's logs or read a bounded range of up to 1,000 lines. |
| `show_pipeline_run` | Show a PR-styled run card with status, branch, commit, duration, and task results. |
| `show_pipeline_run_log` | Show a PR-styled log preview with line numbers, timestamps, severity highlighting, and bounded paging. |
| `run_pipeline` | Queue a confirmed YAML or classic run on an explicit branch, optionally pinned to a commit. |
| `cancel_pipeline_run` | Request cancellation of a run after explicit confirmation. |
| `update_pipeline` | Update confirmed definition settings and non-secret variables with a revision check. |
| `get_pipeline_yaml` | Read the configured Azure Repos YAML file at an exact branch-tip commit. |
| `update_pipeline_yaml` | Commit confirmed YAML changes to an existing branch with a branch-tip conflict check. |

## CI Pipelines

Pipeline tools reuse the same Microsoft session and workspace discovery as PR tools. `pipelineId` identifies a definition; `runId` identifies one execution. Repository-scoped discovery accepts the repository name or ID from `get_workspace_repositories`. Lists return continuation tokens for subsequent pages.

Before queueing, cancelling, or editing, the agent must present the exact operation and obtain explicit confirmation. Runs can deploy software or trigger other side effects. YAML runs accept typed `templateParameters` and non-secret queue-time `variables`; classic runs accept string `parameters`. A manual run on a PR's source branch is not a requeue of its branch-policy validation. PR run discovery filters `refs/pull/<id>/merge`; source-branch manual runs can be found with the `branch` filter instead.

Monitoring returns a current snapshot, not an unattended background watcher. Read `get_pipeline_run` for stage/job/task progress and issues, then request the relevant log ID and line range. Queued runs may not have a timeline yet. Cancellation is asynchronous, so check the run again to see its final status. Logs and YAML may contain sensitive text; review output before sharing it, and keep secrets out of tool arguments.

Ask to "show this pipeline run" or "preview this task's log" to open a compact chat card using the same theme as PR reviews. Run cards include status, branch, commit, timing, task results and log buttons. Log cards provide a scrollable, line-numbered preview, copy, and previous/next ranges. Refresh is manual; cards never queue, cancel, edit, or poll pipelines. The ordinary `get_pipeline_run` and `get_pipeline_run_log` tools remain JSON-only for analysis without opening extra cards. Log content is rendered as text, not HTML.

Definition edits support name, description, folder, queue status, default branch, configured YAML path, and non-secret variables. They require the revision from `get_pipeline`, preserve unrelated settings and secret variables, and reject stale edits. Classic task graphs and triggers are not editable through these tools.

For YAML edits, read `get_pipeline_yaml` on the intended feature branch, review the replacement content and commit message, then confirm `update_pipeline_yaml` with the returned revision and commit ID. It creates a remote Git commit without changing the local working tree. A branch advance is rejected rather than overwritten; read and review again before retrying. YAML edits require an Azure Repos Git-backed pipeline, apply to its configured file only, and do not bypass branch policies. Template files can be edited through the normal repository workflow.

Your account needs the corresponding Azure DevOps permissions to view, queue, stop, or edit builds, plus Git contribution permission for YAML commits. The extension does not elevate permissions or store additional credentials.

## Pull Request Drafts

`create_pull_request` prepares a local draft instead of publishing immediately. Review and edit its title and description in the interactive card, then explicitly confirm before an agent calls `submit_pull_request`. Deleting a draft only removes its local shared state; it never deletes an Azure DevOps pull request.

## Security and Privacy

- **Local communication:** MCP communication stays on your machine and uses standard input/output.
- **Existing VS Code authentication:** The extension requests Azure DevOps access through VS Code's Microsoft authentication provider rather than storing credentials itself.
- **Official SDKs:** Built with the official MCP TypeScript SDK and `azure-devops-node-api`.
- **Session management:** Manage or sign out of the Microsoft account through VS Code's Accounts menu. Session recovery does not require restarting the MCP server or starting a new agent conversation.

## Requirements

- VS Code 1.125.0 or later
- VS Code built-in Git extension enabled
- GitHub Copilot Chat or another MCP-compatible agent host
- Access to the relevant Azure DevOps organization and repositories

## Development

```bash
npm install
npm test
```

Run `npm run compile` to type-check, lint, and bundle the extension. Press `F5` in VS Code to launch an Extension Development Host.

For a local install, run `npx @vscode/vsce package`, then `code --install-extension azure-devops-prs-mcp-<version>.vsix --force` and reload the VS Code window. Extension and MCP provider IDs stay unchanged across the PR-and-pipelines naming update. `npm test` includes a stdio handshake against the bundled server to check that its title, instructions, pipeline tools, and confirmation schemas reach MCP clients.

## Feedback and Issues

Report bugs or request features in the [GitHub repository](https://github.com/uhvogala/azure-devops-mcp-vscode/issues).
