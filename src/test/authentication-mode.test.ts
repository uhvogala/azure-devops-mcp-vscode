import * as assert from 'assert';
import {
	AccessTokenRequests,
	authenticationFailure,
	authenticationSessionOptions,
	isBackgroundRefresh,
	isInteractiveAccessTokenRequest,
	missingOrExpiredAuthenticationMessage,
	settleSessionLookup,
} from '../authentication-mode';

suite('Azure DevOps authentication mode', () => {
	test('uses a silent session lookup without a sign-in prompt', () => {
		const options = authenticationSessionOptions(false);
		assert.deepStrictEqual(options, { silent: true });
		assert.strictEqual('createIfNone' in options, false);
	});

	test('uses createIfNone with a detail string for an interactive session lookup', () => {
		const options = authenticationSessionOptions(true);
		assert.strictEqual('silent' in options, false);
		assert.strictEqual(options.createIfNone.detail.length > 0, true);
	});

	test('treats only an explicit interactive flag as a prompting access-token request', () => {
		assert.strictEqual(isInteractiveAccessTokenRequest({}), false);
		assert.strictEqual(isInteractiveAccessTokenRequest({ interactive: false }), false);
		assert.strictEqual(isInteractiveAccessTokenRequest({ interactive: true }), true);
		assert.strictEqual(isBackgroundRefresh({ background: true }), true);
		assert.strictEqual(isBackgroundRefresh({}), false);
	});

	test('reports missing authentication with the words the agent instructions match', () => {
		assert.strictEqual(
			authenticationFailure().message.includes('missing or expired authentication'),
			true,
		);
		const wrapped = authenticationFailure('Unable to obtain an Azure DevOps access token (500).');
		assert.strictEqual(wrapped.message.includes('missing or expired authentication'), true);
		assert.notStrictEqual(wrapped.message, 'Unable to obtain an Azure DevOps access token (500).');
		assert.strictEqual(
			authenticationFailure(missingOrExpiredAuthenticationMessage).message,
			missingOrExpiredAuthenticationMessage,
		);
	});

	test('does not time out an interactive sign-in lookup', async () => {
		const session = await settleSessionLookup(true, new Promise<{ accessToken: string }>(resolve => {
			setTimeout(() => resolve({ accessToken: 'interactive-token' }), 40);
		}), 10);
		assert.deepStrictEqual(session, { accessToken: 'interactive-token' });
	});

	test('times out a silent lookup that never returns', async () => {
		await assert.rejects(
			settleSessionLookup(false, new Promise<undefined>(() => undefined), 20),
			(error: unknown) => error instanceof Error && error.message.includes('missing or expired authentication'),
		);
	});

	test('keeps an interactive token request from waiting on a silent one', async () => {
		const requests = new AccessTokenRequests();
		let silentLoads = 0;
		const silent = requests.get(false, () => {
			silentLoads += 1;
			return new Promise(() => undefined);
		});
		const interactive = await requests.get(true, async () => 'signed-in');
		assert.strictEqual(interactive, 'signed-in');
		assert.strictEqual(silentLoads, 1);
		let silentSettled = false;
		void silent.then(() => {
			silentSettled = true;
		}, () => {
			silentSettled = true;
		});
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.strictEqual(silentSettled, false);
	});

	test('shares one in-flight lookup per mode', async () => {
		const requests = new AccessTokenRequests();
		let loads = 0;
		const load = () => {
			loads += 1;
			return Promise.resolve('token');
		};
		const [first, second] = await Promise.all([
			requests.get(false, load),
			requests.get(false, load),
		]);
		assert.strictEqual(first, 'token');
		assert.strictEqual(second, 'token');
		assert.strictEqual(loads, 1);
	});
});
