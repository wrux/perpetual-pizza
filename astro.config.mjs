import { defineConfig } from 'astro/config';

// The per-pizza video pages are gone; send old links home.
const oldPizzaPages = Object.fromEntries(['01', '02', '03', '04', '05', '06'].map((slug) => [`/pizza/${slug}`, '/']));

export default defineConfig({
  output: 'static',
  redirects: {
    '/pizza': '/',
    ...oldPizzaPages,
  },
});
