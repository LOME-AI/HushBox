import { Config } from '@remotion/cli/config';

import { DEFAULT_GL } from './engine/cli/command.js';
import { filmsWebpackOverride } from './engine/render/webpack-override.js';

// `staticFile('<film-id>/...')` resolves under public/, which holds only render
// products such as each film's master; Remotion walks the public directory whole,
// so it is never a directory that holds node_modules.
Config.setEntryPoint('./src/index.ts');
Config.setPublicDir('./public');
Config.setChromiumOpenGlRenderer(DEFAULT_GL);
Config.overrideWebpackConfig(filmsWebpackOverride);
