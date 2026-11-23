import { defineConfig } from 'astro/config';
import shaders, { shippedUniformNames } from './tools/glsl.mjs';
import glConstants from './tools/gl-constants.mjs';
import earlyHints from './tools/early-hints.mjs';

/*
 * The minifier shortens property names, which is only safe for names the
 * script keeps to itself. These are the ones it shares with something else, and
 * so must be left as written. A new name of that kind has to be added here,
 * or the built site will quietly lose track of it.
 */
const KEPT_NAMES = [
  // Shader uniforms, set from the script by name.
  ...shippedUniformNames(),
  // Messages between the page and the painting worker, which are minified apart.
  ...['what', 'seed', 'photographed', 'color', 'normal', 'rough', 'heightData'],
  // Settings named in the page's markup (data-key) and in the URL, and the looks and toppings they choose between.
  ...['speed', 'spinTurns', 'direction', 'elevation', 'fov', 'effect', 'toppings'],
  ...['pepperoni', 'mushroom', 'basil', 'olive', 'jalapeno', 'ham', 'film', 'vhs', 'crt'],
  // data- attributes read through dataset.
  ...['key', 'output', 'tab', 'pane'],
  // Fields of the topping photo manifest.
  ...['crust', 'cheeseDetail', 'file', 'cutouts', 'outer', 'inner'],
  // Options handed to the browser, and members of things the minifier's own list of browser names may not cover.
  ...['antialias', 'alpha', 'powerPreference', 'willReadFrequently', 'transfer', 'type', 'once', 'passive'],
  ...['subarray', 'TEXTURE_MAX_ANISOTROPY_EXT', 'MAX_TEXTURE_MAX_ANISOTROPY_EXT'],
];

// The per-pizza video pages are gone; send old links home.
const oldPizzaPages = Object.fromEntries(['01', '02', '03', '04', '05', '06'].map((slug) => [`/pizza/${slug}`, '/']));

export default defineConfig({
  output: 'static',
  integrations: [earlyHints],
  // One small stylesheet: putting it in the page saves a round trip before anything can be drawn.
  build: { inlineStylesheets: 'always' },
  vite: {
    plugins: [shaders, glConstants],
    build: {
      // Slower to build than the default, but squeezes out a little more.
      minify: 'terser',
      terserOptions: {
        ecma: 2020,
        module: true,
        toplevel: true,
        compress: { passes: 3 },
        mangle: { toplevel: true, properties: { reserved: KEPT_NAMES } },
        format: { comments: false },
      },
    },
  },
  // The toolbar Astro adds in development sits over the look strip.
  devToolbar: { enabled: false },
  redirects: {
    '/pizza': '/',
    ...oldPizzaPages,
  },
});
