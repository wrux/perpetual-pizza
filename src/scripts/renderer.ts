/**
 * Draws the pizza: one physically based material, a key light with a shadow,
 * a fill light, sky light and studio reflections, fog and a filmic tone curve.
 * Everything comes out display-ready, so the default look needs no second pass.
 */

import {
  bindTarget,
  createPixel,
  createProgram,
  createTexture,
  glsl,
  lookAt,
  multiply,
  normalize,
  orthographic,
  resolveTarget,
  type Geometry,
  type GL,
  type Mat4,
  type Target,
  type Vec3,
} from './gl';
import BACKDROP from '../shaders/backdrop.glsl';
import DEPTH_FRAGMENT from '../shaders/depth.frag.glsl';
import DEPTH_VERTEX from '../shaders/depth.vert.glsl';
import DISPLAY from '../shaders/display.glsl';
import FRAGMENT from '../shaders/pizza.frag.glsl';
import VERTEX from '../shaders/pizza.vert.glsl';
import SCREEN_VERTEX from '../shaders/screen.vert.glsl';

/** A '#rrggbb' colour as linear light, which is what the lighting works in. */
export function srgb(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [linear(((n >> 16) & 255) / 255), linear(((n >> 8) & 255) / 255), linear((n & 255) / 255)];
}

export interface Grain {
  /** How many times the grain tiles across the material's UVs, along u and v. */
  repeat: [number, number];
  /** Strength of the colour and roughness variation. */
  tint: number;
  /** Strength of the relief. */
  bump: number;
}

export interface Material {
  map?: WebGLTexture | null;
  /** How many times the map repeats across the UVs, where it isn't once: the other maps always span them once. */
  mapRepeat?: [number, number];
  /** Multiplies the map, in linear light. */
  color?: Vec3;
  normalMap?: WebGLTexture | null;
  normalScale?: number;
  roughMap?: WebGLTexture | null;
  rough?: number;
  /** A thin glossy coat over the surface, 0 to 1. */
  clearcoat?: number;
  /** Fine tiling grain layered over the colour, roughness and normals. */
  grain?: Grain;
  /** A close-up photo of melted cheese, laid over the parts of the map that are cheese-coloured. */
  cheese?: WebGLTexture | null;
  /** Draw the inside faces instead of the outside ones. */
  inside?: boolean;
  casts?: boolean;
  receives?: boolean;
}

export interface Mesh {
  material: Material;
  vao: WebGLVertexArrayObject;
  count: number;
  free(): void;
}

export interface Item {
  mesh: Mesh;
  matrix: Mat4;
}

export interface View {
  projection: Mat4;
  view: Mat4;
  eye: Vec3;
}

/* Lights. Colours are in linear light with their brightness multiplied in. */
const times = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
// Key light from behind and to the side, low enough to rake across the
// surface: it picks out every bubble and glints off the grease.
const SUN_AT: Vec3 = [-3.2, 3.1, -2.4];
const SUN = times(srgb('#ffe9cc'), 2.1);
const FILL_FROM = normalize([2.5, 2.5, 3]);
const FILL = times(srgb('#ffe2c4'), 0.55);
const SKY = times(srgb('#fff1dc'), 0.4);
const GROUND = times(srgb('#a8571a'), 0.4);
/** Fog in the backdrop's glow, so the far edge of the biggest pizza melts into it. */
const FOG = srgb('#5a2c12');
const FOG_NEAR = 3.5;
const FOG_FAR = 12;
/** How bright the studio reflections are overall. */
const ENVIRONMENT = 0.35;
const EXPOSURE = 0.82;

const SHADOW_SIZE = 2048;
/** Half the width of the square of ground the shadow map covers. */
const SHADOW_REACH = 2.5;

/** The reflections image: this many blur levels stacked top to bottom, sharpest first. */
const ENV_LEVELS = 7;
const ENV_WIDTH = 64;
const ENV_HEIGHT = 32;

const vec3 = (v: Vec3) => `vec3( ${v.map((x) => x.toFixed(5)).join(', ')} )`;

/**
 * What the shaders are told about the scene: they read these names as
 * constants. Written out as text, so nothing can rename them on the way.
 */
const SCENE = `
#define SUN_FROM ${vec3(normalize(SUN_AT))}
#define SUN ${vec3(SUN)}
#define FILL_FROM ${vec3(FILL_FROM)}
#define FILL ${vec3(FILL)}
#define SKY ${vec3(SKY)}
#define GROUND ${vec3(GROUND)}
#define FOG ${vec3(FOG)}
#define FOG_NEAR ${FOG_NEAR.toFixed(1)}
#define FOG_FAR ${FOG_FAR.toFixed(1)}
#define ENVIRONMENT ${ENVIRONMENT.toFixed(3)}
#define EXPOSURE ${EXPOSURE.toFixed(3)}
#define ENV_TOP ${(ENV_LEVELS - 1).toFixed(1)}
#define SHADOW_STEP ${(1.5 / SHADOW_SIZE).toFixed(6)}
`;

/** Vertical gradient behind the pizza: near-black overhead, an ember glow at the horizon. */
function backdropCanvas() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  // The tone curve darkens this considerably, so the stops are brighter than they look here.
  g.addColorStop(0, '#120704');
  g.addColorStop(0.2, '#2a1108');
  g.addColorStop(0.42, '#8a4a22');
  g.addColorStop(0.55, '#4a2210');
  g.addColorStop(1, '#160804');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 512);
  return c;
}

export interface Renderer {
  /** Put a geometry on the graphics card, ready to draw with a material. */
  upload(geometry: Geometry, material: Material): Mesh;
  /**
   * Set the studio the pizza reflects, from its image: blur levels stacked top
   * to bottom, each a 360° panorama in greys.
   */
  setEnvironment(image: HTMLImageElement): void;
  /** Set the fine grain texture that grained materials share. */
  setGrain(texture: WebGLTexture): void;
  /** Draw the pizza. `stage` draws on an empty, unfogged, shadowless stage with a clear background, for thumbnails. */
  render(items: Item[], view: View, target: Target | null, stage?: boolean): void;
  /** The pixels of a target, bottom row first. */
  read(target: Target): Uint8Array;
}

export function createRenderer(gl: GL): Renderer {
  const program = createProgram(gl, VERTEX, glsl(FRAGMENT, SCENE, DISPLAY));
  const backdrop = createProgram(gl, SCREEN_VERTEX, glsl(BACKDROP, SCENE, DISPLAY));
  const depth = createProgram(gl, DEPTH_VERTEX, DEPTH_FRAGMENT);
  const u = program.u;

  const white = createPixel(gl, 255, 255, 255);
  const level = createPixel(gl, 128, 128, 255);
  const backdropTexture = createTexture(gl, backdropCanvas(), { srgb: true, flat: true });

  // Each sampler keeps one texture unit for good.
  const units = ['uMap', 'uNormalMap', 'uRoughMap', 'uGrainMap', 'uCheeseMap', 'uEnv', 'uShadowMap'];
  gl.useProgram(program.handle);
  units.forEach((name, unit) => gl.uniform1i(u[name], unit));

  /* Shadow map: the scene's depth as the key light sees it. */
  const shadowMap = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, shadowMap);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  const shadowFbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowMap, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const shadowMatrix = multiply(orthographic(SHADOW_REACH, 0.5, 15), lookAt(SUN_AT, [0, 0, 0]));

  const environment = gl.createTexture()!;
  let grain: WebGLTexture | null = null;

  function drawShadows(items: Item[]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(depth.handle);
    gl.uniformMatrix4fv(depth.u.uViewProjection, false, shadowMatrix);
    // Draw the faces turned away from the light, so a surface never shadows itself.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    for (const { mesh, matrix } of items) {
      if (!mesh.material.casts) continue;
      gl.uniformMatrix4fv(depth.u.uModel, false, matrix);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    }
  }

  const bind = (unit: number, texture: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  };

  function useMaterial(m: Material, shadows: boolean) {
    bind(0, m.map ?? white);
    bind(1, m.normalMap ?? level);
    bind(2, m.roughMap ?? white);
    bind(3, grain ?? white);
    bind(4, m.cheese ?? white);
    gl.uniform2fv(u.uMapRepeat, m.mapRepeat ?? [1, 1]);
    gl.uniform3fv(u.uColor, m.color ?? [1, 1, 1]);
    gl.uniform1f(u.uRough, m.rough ?? 1);
    gl.uniform1f(u.uNormalScale, m.normalScale ?? 1);
    gl.uniform1f(u.uClearcoat, m.clearcoat ?? 0);
    gl.uniform2fv(u.uGrainRepeat, m.grain?.repeat ?? [1, 1]);
    gl.uniform1f(u.uGrainTint, m.grain?.tint ?? 0);
    gl.uniform1f(u.uGrainBump, m.grain?.bump ?? 0);
    gl.uniform1f(u.uCheesy, m.cheese ? 1 : 0);
    gl.uniform1f(u.uShadowed, shadows && m.receives ? 1 : 0);
    gl.cullFace(m.inside ? gl.FRONT : gl.BACK);
  }

  return {
    upload(geometry, material) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const buffers = [geometry.position, geometry.normal, geometry.uv].map((data, location) => {
        const buffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, location === 2 ? 2 : 3, gl.FLOAT, false, 0, 0);
        return buffer;
      });
      const index = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.index, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return {
        material,
        vao,
        count: geometry.index.length,
        free() {
          gl.deleteVertexArray(vao);
          [...buffers, index].forEach((b) => gl.deleteBuffer(b));
        },
      };
    },

    setEnvironment(image) {
      const c = document.createElement('canvas');
      c.width = ENV_WIDTH;
      c.height = ENV_HEIGHT * ENV_LEVELS;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const light = new Float32Array(ENV_WIDTH * ENV_HEIGHT * ENV_LEVELS);
      for (let l = 0; l < ENV_LEVELS; l++) {
        for (let y = 0; y < ENV_HEIGHT; y++) {
          // The image's rows run top-down, a texture's bottom-up.
          const row = (l * ENV_HEIGHT + ENV_HEIGHT - 1 - y) * ENV_WIDTH;
          for (let x = 0; x < ENV_WIDTH; x++) {
            // Brightness on a log scale, running up to 63 times white.
            light[(l * ENV_HEIGHT + y) * ENV_WIDTH + x] = Math.pow(2, (data[(row + x) * 4] / 255) * 6) - 1;
          }
        }
      }
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, environment);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R16F, ENV_WIDTH, ENV_HEIGHT, ENV_LEVELS, 0, gl.RED, gl.FLOAT, light);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    },

    setGrain(texture) {
      grain = texture;
    },

    render(items, view, target, stage = false) {
      const shadows = !stage;
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      if (shadows) drawShadows(items);

      bindTarget(gl, target);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!stage) {
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.depthMask(false);
        gl.useProgram(backdrop.handle);
        bind(0, backdropTexture);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
      }

      gl.useProgram(program.handle);
      gl.enable(gl.CULL_FACE);
      gl.uniformMatrix4fv(u.uView, false, view.view);
      gl.uniformMatrix4fv(u.uViewProjection, false, multiply(view.projection, view.view));
      gl.uniformMatrix4fv(u.uShadow, false, shadowMatrix);
      gl.uniform3fv(u.uEye, view.eye);
      gl.uniform1f(u.uFog, stage ? 0 : 1);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, environment);
      bind(6, shadowMap);
      let material: Material | null = null;
      for (const { mesh, matrix } of items) {
        if (mesh.material !== material) useMaterial((material = mesh.material), shadows);
        gl.uniformMatrix4fv(u.uModel, false, matrix);
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
      resolveTarget(gl, target);
    },

    read(target) {
      const pixels = new Uint8Array(target.width * target.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    },
  };
}
