import { cheeseTexture, crustTexture } from './paint';

export type PaintJob = { what: 'cheese'; seed: number; photographed: boolean } | { what: 'crust'; seed: number };

/** Paint what is asked for and hand the maps back without copying them. */
self.onmessage = ({ data }: MessageEvent<PaintJob>) => {
  const maps = data.what === 'cheese' ? cheeseTexture(data.seed, data.photographed) : crustTexture(data.seed);
  self.postMessage(maps, { transfer: [maps.color.buffer, maps.normal.buffer, maps.rough.buffer, maps.heightData.buffer] });
};
