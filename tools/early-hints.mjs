// Build step: tells Cloudflare what each page will need before the page itself
// arrives.
//
// For every built page, the script and the `<link rel="preload">` pictures it
// names are written into `_headers` as `Link` headers. Cloudflare remembers
// those and, with Early Hints switched on for the zone (Speed > Settings >
// Content Optimization), sends them ahead of the page as a `103 Early Hints`
// response, so the browser starts fetching while the page is still on its way.
// Without that setting the headers still arrive with the page, ahead of its
// body, and do no harm.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every built page. Pages build as about.html as well as index.html, and the not-found page is
// left out: it can answer any address, so there's no one address to hint it for.
const pages = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? pages(path.join(dir, e.name)) : e.name.endsWith('.html') && e.name !== '404.html' ? [path.join(dir, e.name)] : []));

/** The address a built page is served at: /index.html at /, /about.html at /about. */
function address(file, out) {
  const parts = path.relative(out, file).split(path.sep);
  const name = parts.pop();
  if (name !== 'index.html') parts.push(name.replace(/\.html$/, ''));
  return '/' + parts.join('/') + (name === 'index.html' && parts.length ? '/' : '');
}

const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** The `Link` header values for one page's HTML, built into the folder `out`. */
function links(html, out) {
  const found = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*\btype="module"[^>]*>/g)) {
    const src = attribute(tag, 'src');
    if (!src) continue;
    // A module script is fetched the way a cross-origin one is, so the hint has to say so to be reused.
    found.push(`<${src}>; rel=preload; as=script; crossorigin`);
    // The workers that script starts. Browsers have no hint for a worker as such, so it is
    // hinted as a plain fetch: that puts it in the browser's cache, where the worker finds it.
    const code = fs.readFileSync(path.join(out, src), 'utf8');
    for (const worker of new Set(code.match(/\/_astro\/[\w.-]*\.worker-[\w.-]*\.js/g))) found.push(`<${worker}>; rel=preload; as=fetch; crossorigin`);
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)) {
    const type = attribute(tag, 'type');
    found.push(`<${attribute(tag, 'href')}>; rel=preload; as=${attribute(tag, 'as')}${type ? `; type="${type}"` : ''}`);
  }
  return found;
}

export default {
  name: 'early-hints',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const out = fileURLToPath(dir);
      const rules = pages(out).flatMap((file) => {
        const found = links(fs.readFileSync(file, 'utf8'), out);
        if (!found.length) return [];
        return [`${address(file, out)}\n${found.map((link) => `  Link: ${link}`).join('\n')}`];
      });
      if (rules.length) fs.appendFileSync(path.join(out, '_headers'), `\n# What each page needs, sent ahead of it. Written by tools/early-hints.mjs.\n${rules.join('\n')}\n`);
    },
  },
};
