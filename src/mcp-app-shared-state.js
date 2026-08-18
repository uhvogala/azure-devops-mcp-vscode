export function subscribeToSharedState(app, sharedState, defaultValue, onChange) {
	if (!sharedState?.key) {
		return () => undefined;
	}

	let active = true;
	let version = sharedState.version ?? 0;
	void (async () => {
		while (active) {
			let result;
			try {
				result = await app.callServerTool({
					name: 'wait_for_shared_state',
					arguments: { key: sharedState.key, afterVersion: version, defaultValue },
				});
			} catch {
				return;
			}
			if (!active) {
				return;
			}
			const state = result.structuredContent;
			if (!state || typeof state.version !== 'number' || state.version <= version) {
				continue;
			}
			version = state.version;
			sharedState.version = version;
			onChange(state.value, state);
		}
	})();

	return () => {
		active = false;
	};
}

export async function setSharedState(app, sharedState, value) {
	if (!sharedState?.key) {
		return undefined;
	}

	let expectedVersion = sharedState.version ?? 0;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await app.callServerTool({
			name: 'set_shared_state',
			arguments: { key: sharedState.key, value, expectedVersion },
		});
		if (result.isError) {
			throw new Error('Unable to update shared state.');
		}
		const state = result.structuredContent;
		if (!state || typeof state.version !== 'number') {
			throw new Error('Invalid shared state response.');
		}
		sharedState.version = state.version;
		if (state.applied) {
			return state;
		}
		expectedVersion = state.version;
	}

	return undefined;
}
