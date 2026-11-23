/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

/** Shader files are brought in as text. */
declare module '*.glsl' {
  const source: string;
  export default source;
}
