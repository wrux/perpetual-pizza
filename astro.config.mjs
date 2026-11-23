import { defineConfig } from 'astro/config';

// The per-pizza video pages are gone; send old links home.
const oldPizzaPages = Object.fromEntries(['01', '02', '03', '04', '05', '06'].map((slug) => [`/pizza/${slug}`, '/']));

/** Shaders live in .glsl files; bring them in as text, without their comments or any space they can do without. */
const shaders = {
  name: 'glsl',
  transform(code, id) {
    if (!id.endsWith('.glsl')) return;
    const text = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter(Boolean)
      // Preprocessor lines keep a line to themselves; everything else runs together.
      .map((line) => (line.startsWith('#') ? `\n${line}\n` : line.replace(/\s+/g, ' ').replace(/ ?([{}()\[\];,=*/<>?:]) ?/g, '$1')))
      .join('')
      .replace(/\n+/g, '\n')
      .trim();
    return { code: `export default ${JSON.stringify(text)};`, map: null };
  },
};

export default defineConfig({
  output: 'static',
  // One small stylesheet: putting it in the page saves a round trip before anything can be drawn.
  build: { inlineStylesheets: 'always' },
  vite: {
    plugins: [shaders],
    build: {
      // Slower to build than the default, but squeezes out a little more.
      minify: 'terser',
      terserOptions: {
        ecma: 2020,
        module: true,
        toplevel: true,
        compress: { passes: 3 },
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
