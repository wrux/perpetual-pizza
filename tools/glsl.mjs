// Build step for the shaders in src/shaders: each .glsl file is brought into
// the script as text, as small as it can safely be made.
//
// - Comments and spare whitespace go.
// - Names the shaders make up for themselves (functions, variables, constants)
//   are shortened. Names the graphics card knows them by are left alone:
//   inputs, outputs, anything on a # line, and built-ins.
// - Uniforms named like `uColor` or `tDiffuse` are shortened too, and the
//   same short names are written into the scripts that set them. Uniforms
//   with plain names (`time`, `resolution`) are left alone, since a script
//   could mean something else by the same word.
//
// Shaders share code through `#include <chunk>` lines, so one table of short
// names is made from every file and used for them all.

import fs from 'node:fs';
import path from 'node:path';

const DIR = 'src/shaders';
const TYPES = 'float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4|void';
/** Built-in functions a shader might also have used as a name of its own somewhere; never renamed. */
const BUILT_IN = new Set(
  'main abs sin cos tan atan acos pow exp exp2 log sqrt inversesqrt floor fract mod min max clamp mix step smoothstep length distance dot cross normalize reflect texture sign all any greaterThan lessThan dFdx dFdy'.split(
    ' ',
  ),
);

/** A shader's lines without comments, blank lines or indentation. */
const lines = (code) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.glsl') ? [path.join(dir, e.name)] : []));

/** Short names for everything the shaders name themselves, the most used getting the shortest. */
function shortNames() {
  const used = new Map(); // every word in every shader, with how often it appears
  const fixed = new Set();
  const own = new Set();
  for (const file of files(DIR)) {
    for (const line of lines(fs.readFileSync(file, 'utf8'))) {
      const words = line.match(/[A-Za-z_]\w*/g) ?? [];
      for (const word of words) used.set(word, (used.get(word) ?? 0) + 1);
      // Names declared here are how the outside world reaches the shader, so they stay.
      if (/^(#|uniform\b|in\b|out\b|varying\b|layout\b)/.test(line)) words.forEach((word) => fixed.add(word));
      else for (const [, name] of line.matchAll(new RegExp(`\\b(?:${TYPES})\\s+([A-Za-z_]\\w*)`, 'g'))) own.add(name);
    }
  }
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const spare = [...letters, ...[...letters].flatMap((a) => [...letters].map((b) => a + b))].filter((name) => !used.has(name));
  const renames = new Map();
  const shared = uniformNames().filter((name) => SHARED.test(name));
  [...own]
    .filter((name) => name.length > 2 && !fixed.has(name) && !BUILT_IN.has(name) && !name.startsWith('gl_'))
    .concat(shared)
    .sort((a, b) => used.get(b) - used.get(a))
    .forEach((name, i) => renames.set(name, spare[i]));
  return renames;
}

/** Uniform names distinctive enough to be replaced wherever a script mentions them. */
const SHARED = /^[ut][A-Z]\w*$/;

/**
 * The names the scripts reach the shaders by, as shipped: every uniform, by
 * its short name where it has one. The scripts' own minifier must leave these
 * alone when it shortens property names.
 */
export function shippedUniformNames() {
  renames ??= shortNames();
  return uniformNames().map((name) => renames.get(name) ?? name);
}

/** Everything declared `uniform` in any shader. */
function uniformNames() {
  const names = new Set();
  for (const file of files(DIR)) {
    for (const line of lines(fs.readFileSync(file, 'utf8'))) {
      if (line.startsWith('uniform')) names.add(line.match(/(\w+)\s*;/)[1]);
    }
  }
  return [...names];
}

let renames;

export default {
  name: 'glsl',
  enforce: 'pre',
  transform(code, id) {
    renames ??= shortNames();
    if (/src\/scripts\/.*\.ts$/.test(id)) {
      return code.replace(/\b[ut][A-Z]\w*\b/g, (word) => (SHARED.test(word) && uniformNames().includes(word) ? renames.get(word) : word));
    }
    if (!id.endsWith('.glsl')) return;
    const text = lines(code)
      // Preprocessor lines keep a line to themselves and their wording; everything else is renamed and run together.
      .map((line) =>
        line.startsWith('#')
          ? `\n${line}\n`
          : line
              // A name after a dot is a field or a swizzle such as .rgb, never one of ours.
              .replace(/(?<![.\w])[A-Za-z_]\w*/g, (word) => renames.get(word) ?? word)
              .replace(/\s+/g, ' ')
              .replace(/ ?([{}()\[\];,=*/<>?:]) ?/g, '$1'),
      )
      .join('')
      .replace(/\n+/g, '\n')
      .trim();
    return { code: `export default ${JSON.stringify(text)};`, map: null };
  },
  // A change to any shader can change the table, so start it afresh.
  watchChange(id) {
    if (id.endsWith('.glsl')) renames = undefined;
  },
};
