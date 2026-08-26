const esbuild = require("esbuild");
const fs = require('node:fs/promises');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
	const define = {
		__AZURE_DEVOPS_MCP_VERSION__: JSON.stringify(packageJson.version),
	};
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts',
			'src/mcp-server.ts'
		],
		bundle: true,
		format: 'cjs',
		define,
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outdir: 'dist',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}

	const reviewCard = await esbuild.build({
		entryPoints: ['src/pr-review-card.js'],
		bundle: true,
		format: 'iife',
		platform: 'browser',
		define,
		target: 'es2022',
		write: false,
		logLevel: 'silent',
	});
	const reviewAssetFiles = {
		notReviewed: 'resources/not-reviewed.svg',
		openDiff: 'resources/open-diff.svg',
		openFile: 'resources/open-file.svg',
		reviewed: 'resources/reviewed.svg',
	};
	const reviewAssets = Object.fromEntries(await Promise.all(Object.entries(reviewAssetFiles).map(async ([name, file]) => [name, `data:image/svg+xml;base64,${await fs.readFile(file, 'base64')}`])));
	const reviewCardCss = await fs.readFile('src/review-card.css', 'utf8');
	const script = `globalThis.__azureDevOpsMcpReviewAssets = ${JSON.stringify(reviewAssets)};\n${reviewCard.outputFiles[0].text}`;
	await fs.copyFile('src/review-card.css', 'dist/review-card.css');
	await fs.writeFile('dist/pr-review-card.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${reviewCardCss}</style></head><body><script>${script}</script></body></html>`);

	await esbuild.build({
		entryPoints: ['src/pr-overview.js'],
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		outfile: 'dist/pr-overview.js',
		logLevel: 'silent',
	});
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
