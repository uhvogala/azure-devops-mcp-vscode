import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	useInstallation: process.env.VSCODE_TEST_EXECUTABLE
		? { fromPath: process.env.VSCODE_TEST_EXECUTABLE }
		: undefined,
});
