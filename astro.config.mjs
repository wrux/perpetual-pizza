import { defineConfig } from 'astro/config';

import vercel from '@astrojs/vercel/static';

// The per-pizza video pages are gone; send old links home.
const oldPizzaPages = Object.fromEntries(['01', '02', '03', '04', '05', '06'].map((slug) => [`/pizza/${slug}`, '/']));

export default defineConfig({
  output: 'static',
  adapter: vercel({
    webAnalytics: {
      enabled: true,
    },
  }),
  redirects: {
    '/pizza': '/',
    ...oldPizzaPages,
  },
});
