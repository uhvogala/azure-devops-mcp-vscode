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
	private signInRequest: Promise<string> | undefined;
	private readonly signedIn = new vscode.EventEmitter<vscode.AuthenticationSession>();
	private nextAuthenticationPromptAt = 0;
	private readonly sessionChangeListener = vscode.authentication.onDidChangeSessions(event => {
		if (event.provider.id === 'microsoft') {
			this.cachedAccessToken = undefined;
		}
	});

	public constructor(
		private readonly requestSession: (createIfNone: boolean) => Promise<vscode.AuthenticationSession | undefined> = async createIfNone => vscode.authentication.getSession('microsoft', azureDevOpsScopes, createIfNone
			? { forceNewSession: { detail: 'Azure DevOps PRs (MCP) needs to renew your Azure DevOps sign-in.' } }
			: { silent: true }),
		private readonly silentRequestTimeoutMs = 10_000,
		private readonly signInRequestTimeoutMs = 45_000,
	) {
	}

	public async signIn(): Promise<void> {
		await this.getSignInToken();
	}

	public async getAccessToken(interactive = false): Promise<string> {
		if (this.signInRequest) {
			return this.signInRequest;
		}
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
		try {
			return await this.accessTokenRequest;
		} catch (error) {
			if (this.signInRequest) {
				return this.signInRequest;
			}
			if (interactive) {
				return this.getSignInToken();
			}
			this.offerSignIn();
			throw error;
		}
	}

	public async getServerEnvironment(): Promise<Record<string, string>> {
		return {
			AZURE_DEVOPS_ACCESS_TOKEN: await this.getAccessToken(),
		};
	}

	public dispose(): void {
		this.sessionChangeListener.dispose();
		this.signedIn.dispose();
	}

	private getSignInToken(): Promise<string> {
		if (!this.signInRequest) {
			this.cachedAccessToken = undefined;
			this.signInRequest = this.getSession(true)
				.then(session => {
					this.cacheAccessToken(session.accessToken);
					this.nextAuthenticationPromptAt = 0;
					this.signedIn.fire(session);
					void vscode.window.showInformationMessage(`Azure DevOps PRs (MCP) is signed in as ${session.account.label}.`);
					return session.accessToken;
				})
				.finally(() => {
					this.signInRequest = undefined;
				});
		}
		return this.signInRequest;
	}

	private cacheAccessToken(accessToken: string): void {
		let expiresAt = Date.now() + accessTokenCacheDurationMs;
		try {
			const payload: unknown = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
			if (payload && typeof payload === 'object' && 'exp' in payload && typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
				expiresAt = Math.min(expiresAt, payload.exp * 1000);
			}
		} catch {}
		if (expiresAt <= Date.now()) {
			throw new Error('The Azure DevOps access token has expired. Sign in again to continue.');
		}
		this.cachedAccessToken = {
			value: accessToken,
			expiresAt,
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
		let signInListener: vscode.Disposable | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const signedInSession = new Promise<vscode.AuthenticationSession>(resolve => {
				signInListener = this.signedIn.event(resolve);
			});
			const timedOut = new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error('Azure DevOps authentication timed out. Complete sign-in, then retry the command.')),
					createIfNone ? this.signInRequestTimeoutMs : this.silentRequestTimeoutMs);
			});
			const session = await Promise.race([this.requestSession(createIfNone), signedInSession, timedOut]);
			if (!session) {
				throw new Error('Azure DevOps authentication is unavailable. Run “Azure DevOps PRs (MCP): Sign In to Azure DevOps” to continue.');
			}
			return session;
		} finally {
			clearTimeout(timeout);
			signInListener?.dispose();
		}
	}
}