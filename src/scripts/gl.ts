/**
 * The little of a 3D engine this site needs, written straight against WebGL2:
 * matrices, triangle meshes, textures, render targets and full-screen passes.
 */

import SCREEN_FRAGMENT from '../shaders/screen.frag.glsl';
import SCREEN_VERTEX from '../shaders/screen.vert.glsl';

export type GL = WebGL2RenderingContext;
export type Vec3 = [number, number, number];
/** A 4x4 matrix in column-major order, as GL wants it. */
export type Mat4 = Float32Array;

/* ------------------------------------------------------------------ */
/* Matrices                                                            */
/* ------------------------------------------------------------------ */

export const identity = (): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** a · b: the transform that applies b first, then a. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Several transforms in a row: the last one listed is applied to a point first. */
export const compose = (...ms: Mat4[]) => ms.reduce(multiply);

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y = x, z = x): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** Rotation about the x (0), y (1) or z (2) axis, anticlockwise looking down the axis. */
export function rotation(axis: 0 | 1 | 2, angle: number): Mat4 {
  const m = identity();
  const a = (axis + 1) % 3;
  const b = (axis + 2) % 3;
  m[a * 4 + a] = m[b * 4 + b] = Math.cos(angle);
  m[a * 4 + b] = Math.sin(angle);
  m[b * 4 + a] = -Math.sin(angle);
  return m;
}

export function perspective(fovDegrees: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovDegrees * Math.PI) / 360);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** A box-shaped view volume `half` wide either side of the axis, for the shadow light. */
export function orthographic(half: number, near: number, far: number): Mat4 {
  const m = identity();
  m[0] = m[5] = 1 / half;
  m[10] = -2 / (far - near);
  m[14] = -(far + near) / (far - near);
  return m;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** View matrix for a camera at `eye` looking at `target`, y up. */
export function lookAt(eye: Vec3, target: Vec3): Mat4 {
  const z = normalize(sub(eye, target));
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** An indexed triangle mesh: three floats a vertex for position and normal, two for uv. */
export class Geometry {
  normal: Float32Array;

  constructor(
    public position: Float32Array,
    public uv: Float32Array,
    public index: Uint32Array,
    normal?: Float32Array,
  ) {
    this.normal = normal ?? new Float32Array(position.length);
    if (!normal) this.computeNormals();
  }

  get count() {
    return this.position.length / 3;
  }

  clone() {
    return new Geometry(this.position.slice(), this.uv.slice(), this.index.slice(), this.normal.slice());
  }

  /** Move every vertex by a matrix, turning the normals to match. */
  transform(m: Mat4) {
    const p = this.position;
    const n = this.normal;
    // Normals go by the inverse transpose of the matrix's 3x3 part (here its
    // cofactors, named by column then row), so they stay square to a stretched surface.
    const c00 = m[5] * m[10] - m[6] * m[9];
    const c01 = m[6] * m[8] - m[4] * m[10];
    const c02 = m[4] * m[9] - m[5] * m[8];
    const c10 = m[2] * m[9] - m[1] * m[10];
    const c11 = m[0] * m[10] - m[2] * m[8];
    const c12 = m[1] * m[8] - m[0] * m[9];
    const c20 = m[1] * m[6] - m[2] * m[5];
    const c21 = m[2] * m[4] - m[0] * m[6];
    const c22 = m[0] * m[5] - m[1] * m[4];
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      p[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const nx = n[i];
      const ny = n[i + 1];
      const nz = n[i + 2];
      const tx = c00 * nx + c10 * ny + c20 * nz;
      const ty = c01 * nx + c11 * ny + c21 * nz;
      const tz = c02 * nx + c12 * ny + c22 * nz;
      const length = Math.hypot(tx, ty, tz) || 1;
      n[i] = tx / length;
      n[i + 1] = ty / length;
      n[i + 2] = tz / length;
    }
    return this;
  }

  /** Smooth normals: each vertex takes the area-weighted average of the faces around it. */
  computeNormals() {
    const p = this.position;
    const n = this.normal.fill(0);
    const ix = this.index;
    for (let f = 0; f < ix.length; f += 3) {
      const a = ix[f] * 3;
      const b = ix[f + 1] * 3;
      const c = ix[f + 2] * 3;
      const ux = p[c] - p[b];
      const uy = p[c + 1] - p[b + 1];
      const uz = p[c + 2] - p[b + 2];
      const vx = p[a] - p[b];
      const vy = p[a + 1] - p[b + 1];
      const vz = p[a + 2] - p[b + 2];
      const x = uy * vz - uz * vy;
      const y = uz * vx - ux * vz;
      const z = ux * vy - uy * vx;
      for (const v of [a, b, c]) {
        n[v] += x;
        n[v + 1] += y;
        n[v + 2] += z;
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const length = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= length;
      n[i + 1] /= length;
      n[i + 2] /= length;
    }
    return this;
  }
}

/** Build a geometry from plain arrays, working out its normals. */
export const geometryFrom = (positions: number[], uvs: number[], index: number[]) =>
  new Geometry(new Float32Array(positions), new Float32Array(uvs), new Uint32Array(index));

/** Join several geometries into one, so they draw in a single call. */
export function merge(parts: Geometry[]): Geometry {
  const vertices = parts.reduce((sum, g) => sum + g.count, 0);
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const index = new Uint32Array(parts.reduce((sum, g) => sum + g.index.length, 0));
  let v = 0;
  let i = 0;
  for (const g of parts) {
    position.set(g.position, v * 3);
    normal.set(g.normal, v * 3);
    uv.set(g.uv, v * 2);
    for (let k = 0; k < g.index.length; k++) index[i + k] = g.index[k] + v;
    v += g.count;
    i += g.index.length;
  }
  return new Geometry(position, uv, index, normal);
}

/**
 * A grid of quads `across` wide and `along` long, as two triangles each,
 * between rows of `across + 1` vertices. `flip` winds them the other way.
 */
function gridIndex(across: number, along: number, flip = false) {
  const index: number[] = [];
  for (let j = 0; j < along; j++) {
    for (let i = 0; i < across; i++) {
      const a = j * (across + 1) + i;
      const b = a + across + 1;
      if (flip) index.push(b, a, b + 1, a, a + 1, b + 1);
      else index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return index;
}

/**
 * A flat ring in the xy plane facing +z. Vertices run in rows from the inner
 * edge out, `around + 1` to a row, with uvs spanning the ring's bounding square.
 */
export function ring(inner: number, outer: number, around: number, across: number) {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let j = 0; j <= across; j++) {
    const r = inner + ((outer - inner) * j) / across;
    for (let i = 0; i <= around; i++) {
      const a = (i / around) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      positions.push(x, y, 0);
      uvs.push((x / outer + 1) / 2, (y / outer + 1) / 2);
    }
  }
  return geometryFrom(positions, uvs, gridIndex(around, across));
}

/** A torus around the z axis. u runs around the ring, v around the tube starting at its outside edge. */
export function torus(radius: number, tube: number, tubeSegments: number, ringSegments: number) {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let j = 0; j <= tubeSegments; j++) {
    const v = (j / tubeSegments) * Math.PI * 2;
    for (let i = 0; i <= ringSegments; i++) {
      const u = (i / ringSegments) * Math.PI * 2;
      const r = radius + tube * Math.cos(v);
      positions.push(r * Math.cos(u), r * Math.sin(u), tube * Math.sin(v));
      uvs.push(i / ringSegments, j / tubeSegments);
    }
  }
  return geometryFrom(positions, uvs, gridIndex(ringSegments, tubeSegments, true));
}

/** An open-ended tube around the y axis, centred on the origin. */
export function tube(radiusTop: number, radiusBottom: number, height: number, segments: number) {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let j = 0; j <= 1; j++) {
    const r = j ? radiusBottom : radiusTop;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(r * Math.sin(a), height / 2 - j * height, r * Math.cos(a));
      uvs.push(i / segments, 1 - j);
    }
  }
  return geometryFrom(positions, uvs, gridIndex(segments, 1));
}

/** A flat disc in the xy plane facing +z. */
export function disc(radius: number, segments: number) {
  const positions = [0, 0, 0];
  const uvs = [0.5, 0.5];
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    uvs.push((Math.cos(a) + 1) / 2, (Math.sin(a) + 1) / 2);
    if (i) index.push(i, i + 1, 0);
  }
  return geometryFrom(positions, uvs, index);
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

/**
 * Finish a shader from its file. Values worked out in script go in as
 * `#define`s, after the `#version` line if there is one, and each
 * `#include <name>` line is replaced by the chunk of that name.
 */
export function glsl(source: string, defines: Record<string, string | number> = {}, chunks: Record<string, string> = {}): string {
  const lines = Object.entries(defines).map(([name, value]) => `#define ${name} ${value}\n`).join('');
  const versioned = source.startsWith('#version');
  const at = versioned ? source.indexOf('\n') + 1 : 0;
  return (source.slice(0, at) + lines + source.slice(at)).replace(/#include <(\w+)>/g, (_, name) => chunks[name]);
}

/* ------------------------------------------------------------------ */
/* Programs                                                            */
/* ------------------------------------------------------------------ */

export interface Program {
  handle: WebGLProgram;
  /** Uniform locations by name. */
  u: Record<string, WebGLUniformLocation>;
}

export function createProgram(gl: GL, vertex: string, fragment: string): Program {
  const handle = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
    gl.attachShader(handle, shader);
  }
  gl.linkProgram(handle);
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(handle) ?? 'program');
  const u: Program['u'] = {};
  for (let i = 0; i < gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(handle, i)!.name;
    u[name] = gl.getUniformLocation(handle, name)!;
  }
  return { handle, u };
}

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

export interface TextureOptions {
  /** The image holds colours (sRGB) rather than data such as normals or roughness. */
  srgb?: boolean;
  wrap?: 'repeat' | 'mirror' | 'clamp';
  /** Sharpen the texture at glancing angles, up to this many samples. */
  anisotropy?: number;
  /** Skip the mipmaps, for images only ever shown at their own size. */
  flat?: boolean;
}

/** Upload an image or canvas, with its top row at v = 1. */
export function createTexture(gl: GL, source: TexImageSource, o: TextureOptions = {}): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, o.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  const wrap = o.wrap === 'repeat' ? gl.REPEAT : o.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.flat ? gl.LINEAR : gl.LINEAR_MIPMAP_LINEAR);
  if (!o.flat) gl.generateMipmap(gl.TEXTURE_2D);
  const ext = o.anisotropy && gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) {
    gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(o.anisotropy!, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
  return texture;
}

/** A one-pixel texture, for materials that have no map of their own. */
export function createPixel(gl: GL, r: number, g: number, b: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  return texture;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  return image.decode().then(() => image);
}

/* ------------------------------------------------------------------ */
/* Render targets                                                      */
/* ------------------------------------------------------------------ */

/**
 * Something to draw into instead of the canvas.
 * - `image`: a picture only, for full-screen passes.
 * - `scene`: adds a depth buffer and smooths edges, for drawing the pizza.
 * - `blocky`: a small, unsmoothed picture that also keeps each pixel's depth
 *   and facing, which the pixel look draws its outlines from.
 */
export type TargetKind = 'image' | 'scene' | 'blocky';

export interface Target {
  kind: TargetKind;
  width: number;
  height: number;
  /** The finished picture. */
  texture: WebGLTexture;
  /** Framebuffer the picture lives in. */
  fbo: WebGLFramebuffer;
  /** Multisampled framebuffer that is drawn into and then resolved into `fbo`. */
  smooth?: WebGLFramebuffer;
  normal?: WebGLTexture;
  depth?: WebGLTexture;
  /** Everything to delete with the target. */
  owned: Array<() => void>;
}

export function createTarget(gl: GL, kind: TargetKind, width: number, height: number): Target {
  const owned: Target['owned'] = [];
  const colour = (format: number, filter: number) => {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    owned.push(() => gl.deleteTexture(texture));
    return texture;
  };
  const framebuffer = () => {
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    owned.push(() => gl.deleteFramebuffer(fbo));
    return fbo;
  };
  const filter = kind === 'blocky' ? gl.NEAREST : gl.LINEAR;
  const texture = colour(gl.RGBA8, filter);
  const fbo = framebuffer();
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const target: Target = { kind, width, height, texture, fbo, owned };

  if (kind === 'blocky') {
    target.normal = colour(gl.RGBA8, gl.NEAREST);
    target.depth = colour(gl.DEPTH_COMPONENT24, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, target.normal, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, target.depth, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  }
  if (kind === 'scene') {
    target.smooth = framebuffer();
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    for (const [attachment, format] of [
      [gl.COLOR_ATTACHMENT0, gl.RGBA8],
      [gl.DEPTH_ATTACHMENT, gl.DEPTH_COMPONENT24],
    ]) {
      const buffer = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, buffer);
      owned.push(() => gl.deleteRenderbuffer(buffer));
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return target;
}

export const deleteTarget = (target: Target | null) => target?.owned.forEach((free) => free());

/** Point drawing at a target, or at the canvas for null. */
export function bindTarget(gl: GL, target: Target | null) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? (target.smooth ?? target.fbo) : null);
  gl.viewport(0, 0, target ? target.width : gl.drawingBufferWidth, target ? target.height : gl.drawingBufferHeight);
}

/** Finish a smoothed target: fold its samples down into its picture. */
export function resolveTarget(gl: GL, target: Target | null) {
  if (!target?.smooth) return;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.smooth);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.fbo);
  gl.blitFramebuffer(0, 0, target.width, target.height, 0, 0, target.width, target.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
}

/* ------------------------------------------------------------------ */
/* Full-screen passes                                                  */
/* ------------------------------------------------------------------ */

type UniformValue = number | number[] | WebGLTexture;

/** A shader that fills its target from other pictures. Its source is the body of a fragment shader in WebGL1 style. */
export interface ScreenPass {
  /** Run the pass into `target`. Textures are bound in the order they are listed. */
  draw(target: Target | null, uniforms: Record<string, UniformValue>): void;
  dispose(): void;
}

export function createScreenPass(gl: GL, fragmentBody: string): ScreenPass {
  const program = createProgram(gl, SCREEN_VERTEX, `${SCREEN_FRAGMENT}\n${fragmentBody}`);
  return {
    draw(target, uniforms) {
      bindTarget(gl, target);
      gl.useProgram(program.handle);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(null);
      let unit = 0;
      for (const [name, value] of Object.entries(uniforms)) {
        const at = program.u[name];
        if (!at) continue;
        if (typeof value === 'number') gl.uniform1f(at, value);
        else if (Array.isArray(value)) (value.length === 2 ? gl.uniform2fv : gl.uniform4fv).call(gl, at, value);
        else {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, value);
          gl.uniform1i(at, unit++);
        }
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose: () => gl.deleteProgram(program.handle),
  };
}
