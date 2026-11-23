import { defineConfig } from 'astro/config';

// The per-pizza video pages are gone; send old links home.
const oldPizzaPages = Object.fromEntries(['01', '02', '03', '04', '05', '06'].map((slug) => [`/pizza/${slug}`, '/']));

/** Shaders live in .glsl files; bring them in as text, without their comments and indentation. */
const shaders = {
  name: 'glsl',
  transform(code, id) {
    if (!id.endsWith('.glsl')) return;
    const text = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter(Boolean)
      .join('\n');
    return { code: `export default ${JSON.stringify(text)};`, map: null };
  },
};

export default defineConfig({
  output: 'static',
  // One small stylesheet: putting it in the page saves a round trip before anything can be drawn.
  build: { inlineStylesheets: 'always' },
  vite: { plugins: [shaders] },
  // The toolbar Astro adds in development sits over the look strip.
  devToolbar: { enabled: false },
  redirects: {
    '/pizza': '/',
    ...oldPizzaPages,
  },
});
