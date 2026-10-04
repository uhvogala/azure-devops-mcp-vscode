export const missingOrExpiredAuthenticationMessage = 'Azure DevOps sign-in failed because of missing or expired authentication. Run “Azure DevOps PRs (MCP): Sign In to Azure DevOps” to continue.';
export const silentAuthenticationTimeoutMs = 20_000;

const interactiveSignInDetail = 'Azure DevOps PRs (MCP) needs access to Azure DevOps as you.';

export interface SilentAuthenticationSessionOptions {
	silent: true;
}

export interface InteractiveAuthenticationSessionOptions {
	createIfNone: { detail: string };
}

export function authenticationSessionOptions(interactive: true): InteractiveAuthenticationSessionOptions;
export function authenticationSessionOptions(interactive: false): SilentAuthenticationSessionOptions;
export function authenticationSessionOptions(interactive: boolean): SilentAuthenticationSessionOptions | InteractiveAuthenticationSessionOptions;
export function authenticationSessionOptions(interactive: boolean): SilentAuthenticationSessionOptions | InteractiveAuthenticationSessionOptions {
	if (interactive) {
		return { createIfNone: { detail: interactiveSignInDetail } };
	}
	return { silent: true };
}

export function isInteractiveAccessTokenRequest(value: unknown): boolean {
	return Boolean(value)
		&& typeof value === 'object'
		&& (value as { interactive?: unknown }).interactive === true;
}

export function isBackgroundRefresh(value: unknown): boolean {
	return Boolean(value)
		&& typeof value === 'object'
		&& (value as { background?: unknown }).background === true;
}

export function authenticationFailure(detail?: string): Error {
	const text = detail?.trim();
	if (text?.includes('missing or expired authentication')) {
		return new Error(text);
	}
	if (text) {
		return new Error(`${missingOrExpiredAuthenticationMessage} ${text}`);
	}
	return new Error(missingOrExpiredAuthenticationMessage);
}

export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(() => {
			finish(() => reject(timeoutError()));
		}, timeoutMs);
		promise.then(
			value => finish(() => resolve(value)),
			error => finish(() => reject(error instanceof Error ? error : timeoutError())),
		);
	});
}

export function settleSessionLookup<T>(
	interactive: boolean,
	lookup: PromiseLike<T | undefined>,
	timeoutMs = silentAuthenticationTimeoutMs,
): Promise<T> {
	const settled = Promise.resolve(lookup).then(session => {
		if (!session) {
			throw authenticationFailure();
		}
		return session;
	}).catch(error => {
		throw authenticationFailure(error instanceof Error ? error.message : undefined);
	});
	if (interactive) {
		return settled;
	}
	return withDeadline(settled, timeoutMs, () => authenticationFailure());
}

export class AccessTokenRequests {
	private silentRequest: Promise<string> | undefined;
	private interactiveRequest: Promise<string> | undefined;

	public get(interactive: boolean, load: () => Promise<string>): Promise<string> {
		if (interactive) {
			this.interactiveRequest ??= load().finally(() => {
				this.interactiveRequest = undefined;
			});
			return this.interactiveRequest;
		}
		this.silentRequest ??= load().finally(() => {
			this.silentRequest = undefined;
		});
		return this.silentRequest;
	}
}
