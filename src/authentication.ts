import * as vscode from 'vscode';

const azureDevOpsScopes = [
	'499b84ac-1321-427f-aa17-267ca6975798/.default',
	'offline_access',
];

export class AzureDevOpsAuthentication {
	public async signIn(): Promise<void> {
		const session = await this.getSession();
		vscode.window.showInformationMessage(`Azure DevOps MCP is signed in as ${session.account.label}.`);
	}

	public async getServerEnvironment(): Promise<Record<string, string>> {
		const session = await this.getSession();
		return {
			AZURE_DEVOPS_ACCESS_TOKEN: session.accessToken,
		};
	}

	private async getSession(): Promise<vscode.AuthenticationSession> {
		return vscode.authentication.getSession('microsoft', azureDevOpsScopes, {
			createIfNone: { detail: 'Azure DevOps MCP needs access to Azure DevOps as you.' },
		});
	}
}