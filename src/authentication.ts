import * as vscode from 'vscode';
import {
	AccessTokenRequests,
	authenticationSessionOptions,
	settleSessionLookup,
} from './authentication-mode';

const azureDevOpsScopes = [
	'499b84ac-1321-427f-aa17-267ca6975798/.default',
	'offline_access',
];
const accessTokenCacheDurationMs = 5 * 60 * 1000;

export class AzureDevOpsAuthentication implements vscode.Disposable {
	private cachedAccessToken: { value: string; expiresAt: number } | undefined;
	private readonly accessTokenRequests = new AccessTokenRequests();
	private readonly sessionChangeListener = vscode.authentication.onDidChangeSessions(event => {
		if (event.provider.id === 'microsoft') {
			this.cachedAccessToken = undefined;
		}
	});

	public async signIn(): Promise<void> {
		this.cachedAccessToken = undefined;
		const session = await settleSessionLookup(true, this.requestSession(true));
		this.cacheAccessToken(session.accessToken);
		vscode.window.showInformationMessage(`Azure DevOps PRs (MCP) is signed in as ${session.account.label}.`);
	}

	public async getAccessToken(interactive = false): Promise<string> {
		if (this.cachedAccessToken && this.cachedAccessToken.expiresAt > Date.now()) {
			return this.cachedAccessToken.value;
		}
		return this.accessTokenRequests.get(interactive, () => this.loadAccessToken(interactive));
	}

	public async getServerEnvironment(interactive = true): Promise<Record<string, string>> {
		return {
			AZURE_DEVOPS_ACCESS_TOKEN: await this.getAccessToken(interactive),
		};
	}

	public dispose(): void {
		this.sessionChangeListener.dispose();
	}

	private async loadAccessToken(interactive: boolean): Promise<string> {
		const session = await settleSessionLookup(interactive, this.requestSession(interactive));
		this.cacheAccessToken(session.accessToken);
		return session.accessToken;
	}

	private requestSession(interactive: boolean): Thenable<vscode.AuthenticationSession | undefined> {
		if (interactive) {
			return vscode.authentication.getSession('microsoft', azureDevOpsScopes, {
				createIfNone: authenticationSessionOptions(true).createIfNone,
			});
		}
		return vscode.authentication.getSession('microsoft', azureDevOpsScopes, authenticationSessionOptions(false));
	}

	private cacheAccessToken(accessToken: string): void {
		this.cachedAccessToken = {
			value: accessToken,
			expiresAt: Date.now() + accessTokenCacheDurationMs,
		};
	}
}
