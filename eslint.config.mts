import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';
import { DEFAULT_ACRONYMS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

// The plugin's own stylized name, so the sentence-case rule keeps its casing
// instead of flattening it to "Ultisync" the way it would any other word.
const brands = [...DEFAULT_BRANDS, 'UltiSync'];
// GitHub's own term for the token this plugin authenticates with.
const acronyms = [...DEFAULT_ACRONYMS, 'PAT'];

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'scripts',
		'tests',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// Matches the recommended config's own options for this rule, plus brands/acronyms.
			'obsidianmd/ui/sentence-case': ['warn', { brands, acronyms, enforceCamelCaseLower: true }],
			'obsidianmd/ui/sentence-case-json': ['warn', { brands, acronyms }],
		},
	},
);
