import { Config } from '@remotion/cli/config';

// Mirrors the webpackOverride in @fako/media-engine's renderQuizVideo(), so `npm run preview`
// resolves the same explicit ".js" (NodeNext-style) relative imports used across this monorepo.
Config.overrideWebpackConfig(config => ({
    ...config,
    resolve: { ...config.resolve, extensionAlias: { ...config.resolve?.extensionAlias, '.js': ['.ts', '.tsx', '.js'] } }
}));
