import { createScreenPass, createTarget, deleteTarget, glsl, type GL, type Target } from './gl';
import COPY from '../shaders/copy.glsl';
import COMMON from '../shaders/looks/common.glsl';
import CRT from '../shaders/looks/crt.glsl';
import FILM from '../shaders/looks/film.glsl';
import LSD from '../shaders/looks/lsd.glsl';
import OIL from '../shaders/looks/oil.glsl';
import PIXEL from '../shaders/looks/pixel.glsl';
import PSYCHEDELIC from '../shaders/looks/psychedelic.glsl';
import TRANSITION from '../shaders/looks/transition.glsl';
import VHS from '../shaders/looks/vhs.glsl';

export const EFFECTS = [
  'none',
  'pixelate',
  'oil',
  'film',
  'vhs',
  'crt',
  'psychedelic',
  'lsd',
] as const;
export type EffectName = (typeof EFFECTS)[number];

export const effectLabels: Record<EffectName, string> = {
  none: 'Default',
  pixelate: 'Pixel',
  oil: 'Oil Painting',
  film: 'Old Film',
  vhs: 'VHS',
  crt: 'CRT',
  psychedelic: 'Psychedelic',
  lsd: 'Acid',
};

/** Looks that are one shader over the plain render. */
const singlePassLooks: Partial<Record<EffectName, string>> = {
  oil: OIL,
  film: FILM,
  vhs: VHS,
  crt: CRT,
  psychedelic: PSYCHEDELIC,
};

/** A wipe from a stored frame to the live one, used when the look or the pizza changes. */
export interface Transition {
  readonly running: boolean;
  /** Begin wiping; the frames are supplied each time it is drawn. */
  begin(now: number, duration?: number): void;
  /** Advance the wipe; it stops itself when finished. */
  tick(now: number): void;
  draw(live: Target, previous: Target, target: Target | null): void;
}

export function createTransition(gl: GL): Transition {
  const pass = createScreenPass(gl, TRANSITION);
  let start = 0;
  let duration = 700;
  let progress = 1;
  let running = false;
  return {
    get running() {
      return running;
    },
    begin(now, length = 700) {
      start = now;
      duration = length;
      progress = 0;
      running = true;
    },
    tick(now) {
      if (!running) return;
      const t = Math.min((now - start) / duration, 1);
      progress = t * t * (3 - 2 * t);
      if (t >= 1) running = false;
    },
    draw(live, previous, target) {
      pass.draw(target, { tDiffuse: live.texture, tPrev: previous.texture, resolution: [live.width, live.height], progress });
    },
  };
}

export interface EffectContext {
  gl: GL;
  effect: EffectName;
  /** Pixel block size for the pixel look, in device pixels. */
  pixelSize: number;
  /** Draw the plain pizza into a target, or onto the canvas for null. */
  drawScene(target: Target | null): void;
}

export interface EffectPipeline {
  /** Draw the pizza in this look into a target, or onto the canvas for null. */
  render(target: Target | null, elapsed: number): void;
  /** Size of the finished picture, in device pixels. */
  setSize(width: number, height: number): void;
  setPixelSize(size: number): void;
  dispose(): void;
}

export function createPipeline({ gl, effect, pixelSize, drawScene }: EffectContext): EffectPipeline {
  const blocky = effect === 'pixelate';
  const source = blocky ? PIXEL : effect === 'lsd' ? LSD : singlePassLooks[effect];
  const look = source ? createScreenPass(gl, glsl(source, {}, { common: COMMON })) : null;
  const copy = createScreenPass(gl, COPY);
  let width = 1;
  let height = 1;
  // Made when first needed: the default look draws straight onto the canvas and needs none of them.
  let scene: Target | null = null;
  /** The acid look's afterimages: last frame's result, and a spare to draw this frame's into. */
  let echo: Target[] | null = null;

  const release = () => {
    deleteTarget(scene);
    echo?.forEach(deleteTarget);
    scene = echo = null;
  };

  return {
    render(target, time) {
      if (!look && !target) return drawScene(null);
      scene ??= blocky
        ? createTarget(gl, 'blocky', Math.max(1, Math.floor(width / pixelSize)), Math.max(1, Math.floor(height / pixelSize)))
        : createTarget(gl, 'scene', width, height);
      drawScene(scene);
      const resolution = [width, height];
      if (!look) copy.draw(target, { tDiffuse: scene.texture });
      else if (blocky) {
        look.draw(target, {
          tDiffuse: scene.texture,
          tDepth: scene.depth!,
          tNormal: scene.normal!,
          resolution: [scene.width, scene.height, 1 / scene.width, 1 / scene.height],
        });
      } else if (effect === 'lsd') {
        echo ??= [createTarget(gl, 'image', width, height), createTarget(gl, 'image', width, height)];
        // Composite into the spare, which becomes next frame's history, then copy it out.
        look.draw(echo[1], { tDiffuse: scene.texture, tEcho: echo[0].texture, resolution, time });
        copy.draw(target, { tDiffuse: echo[1].texture });
        echo.reverse();
      } else look.draw(target, { tDiffuse: scene.texture, resolution, time });
    },
    setSize(w, h) {
      width = w;
      height = h;
      release();
    },
    setPixelSize(size) {
      pixelSize = size;
      release();
    },
    dispose() {
      release();
      look?.dispose();
      copy.dispose();
    },
  };
}
