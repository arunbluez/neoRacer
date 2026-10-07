// Encode and decode images with the browser's canvas.

import type { ImageBuf } from '../../core/vision/rectify';

function canvasFor(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export async function encodeImage(img: ImageBuf, mime: 'image/png' | 'image/jpeg', quality = 0.9): Promise<Uint8Array> {
  const c = canvasFor(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), mime, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function decodeImage(bytes: Uint8Array, mime: string): Promise<ImageBuf> {
  const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
  const c = canvasFor(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: d.width, height: d.height, data: d.data };
}

export function drawImageBuf(canvas: HTMLCanvasElement, img: ImageBuf): void {
  if (canvas.width !== img.width) canvas.width = img.width;
  if (canvas.height !== img.height) canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
}
