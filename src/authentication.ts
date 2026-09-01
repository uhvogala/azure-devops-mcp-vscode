import * as vscode from 'vscode';

const azureDevOpsScopes = [
	'499b84ac-1321-427f-aa17-267ca6975798/.default',
	'offline_access',
];
const accessTokenCacheDurationMs = 5 * 60 * 1000;
const authenticationPromptCooldownMs = 15 * 60 * 1000;

export class AzureDevOpsAuthentication implements vscode.Disposable {
	private cachedAccessToken: { value: string; expiresAt: number } | undefined;
	private accessTokenRequest: Promise<string> | undefined;
	private nextAuthenticationPromptAt = 0;
	private readonly sessionChangeListener = vscode.authentication.onDidChangeSessions(event => {
		if (event.provider.id === 'microsoft') {
			this.cachedAccessToken = undefined;
		}
	});

	public async signIn(): Promise<void> {
		this.cachedAccessToken = undefined;
		const session = await this.getSession(true);
		this.cacheAccessToken(session.accessToken);
		this.nextAuthenticationPromptAt = 0;
		vscode.window.showInformationMessage(`Azure DevOps PRs (MCP) is signed in as ${session.account.label}.`);
	}

	public async getAccessToken(): Promise<string> {
		if (this.cachedAccessToken && this.cachedAccessToken.expiresAt > Date.now()) {
			return this.cachedAccessToken.value;
		}
		this.accessTokenRequest ??= this.getSession(false)
			.then(session => {
				this.cacheAccessToken(session.accessToken);
				return session.accessToken;
			})
			.finally(() => {
				this.accessTokenRequest = undefined;
			});
		return this.accessTokenRequest;
	}

	public async getServerEnvironment(): Promise<Record<string, string>> {
		return {
			AZURE_DEVOPS_ACCESS_TOKEN: await this.getAccessToken(),
		};
	}

	public dispose(): void {
		this.sessionChangeListener.dispose();
	}

	private cacheAccessToken(accessToken: string): void {
		this.cachedAccessToken = {
			value: accessToken,
			expiresAt: Date.now() + accessTokenCacheDurationMs,
		};
	}

	private offerSignIn(): void {
		if (Date.now() < this.nextAuthenticationPromptAt) {
			return;
		}
		this.nextAuthenticationPromptAt = Date.now() + authenticationPromptCooldownMs;
		void (async () => {
			try {
				const selection = await vscode.window.showWarningMessage(
					'Azure DevOps authentication is required to refresh pull requests.',
					'Sign In',
				);
				if (selection === 'Sign In') {
					await this.signIn();
				}
			} catch {}
		})();
	}

	private async getSession(createIfNone: boolean): Promise<vscode.AuthenticationSession> {
		const session = await vscode.authentication.getSession('microsoft', azureDevOpsScopes, createIfNone
			? { createIfNone: { detail: 'Azure DevOps PRs (MCP) needs access to Azure DevOps as you.' } }
			: { createIfNone: false });
		if (!session) {
			this.offerSignIn();
			throw new Error('Azure DevOps authentication is unavailable. Run “Azure DevOps PRs (MCP): Sign In to Azure DevOps” to continue.');
		}
		return session;
	}
}