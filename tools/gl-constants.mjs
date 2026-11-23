// Build step: writes WebGL constants into the script as plain numbers, so
// `gl.TEXTURE_2D` ships as `3553`. The names cannot be shortened any other
// way, and the numbers are fixed by the WebGL specification.
//
// A constant that is not in the table stops the build; add it with the value
// from `WebGL2RenderingContext.NAME` in a browser console.

const VALUES = {
  ACTIVE_UNIFORMS: 35718,
  ARRAY_BUFFER: 34962,
  BACK: 1029,
  CLAMP_TO_EDGE: 33071,
  COLOR_ATTACHMENT0: 36064,
  COLOR_ATTACHMENT1: 36065,
  COLOR_BUFFER_BIT: 16384,
  COMPARE_REF_TO_TEXTURE: 34894,
  COMPILE_STATUS: 35713,
  CULL_FACE: 2884,
  DEPTH_ATTACHMENT: 36096,
  DEPTH_BUFFER_BIT: 256,
  DEPTH_COMPONENT24: 33190,
  DEPTH_TEST: 2929,
  DRAW_FRAMEBUFFER: 36009,
  ELEMENT_ARRAY_BUFFER: 34963,
  FLOAT: 5126,
  FRAGMENT_SHADER: 35632,
  FRAMEBUFFER: 36160,
  FRONT: 1028,
  LINEAR: 9729,
  LINEAR_MIPMAP_LINEAR: 9987,
  LINK_STATUS: 35714,
  MAX_SAMPLES: 36183,
  MIRRORED_REPEAT: 33648,
  NEAREST: 9728,
  NONE: 0,
  R16F: 33325,
  READ_FRAMEBUFFER: 36008,
  RED: 6403,
  RENDERBUFFER: 36161,
  REPEAT: 10497,
  RGBA: 6408,
  RGBA8: 32856,
  SRGB8_ALPHA8: 35907,
  STATIC_DRAW: 35044,
  TEXTURE0: 33984,
  TEXTURE5: 33989,
  TEXTURE_2D: 3553,
  TEXTURE_2D_ARRAY: 35866,
  TEXTURE_COMPARE_MODE: 34892,
  TEXTURE_MAG_FILTER: 10240,
  TEXTURE_MIN_FILTER: 10241,
  TEXTURE_WRAP_S: 10242,
  TEXTURE_WRAP_T: 10243,
  TRIANGLES: 4,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443,
  UNPACK_FLIP_Y_WEBGL: 37440,
  UNSIGNED_BYTE: 5121,
  UNSIGNED_INT: 5125,
  VERTEX_SHADER: 35633,
};

export default {
  name: 'gl-constants',
  enforce: 'pre',
  transform(code, id) {
    if (!/src\/scripts\/.*\.ts$/.test(id)) return;
    return code.replace(/\bgl\.([A-Z][A-Z0-9_]+)\b/g, (_, name) => {
      if (!(name in VALUES)) this.error(`gl.${name} is not in tools/gl-constants.mjs`);
      return String(VALUES[name]);
    });
  },
};
