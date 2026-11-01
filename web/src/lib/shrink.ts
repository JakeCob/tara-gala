// TG-52: a picture small enough to share on a trip (the API takes up to 5 MB). Phone photos of tickets can be bigger,
// so those are redrawn as a JPEG no wider or taller than 2400 px, which keeps QR codes and booking numbers readable.

import { MAX_FILE_BYTES } from "./trip.ts";

export const MAX_SIDE = 2400;

/** The scale that fits w by h inside MAX_SIDE, never enlarging. */
export function fitScale(w: number, h: number, maxSide = MAX_SIDE): number {
  return Math.min(1, maxSide / Math.max(w, h, 1));
}

/** The picture as is when it's small enough, else a smaller JPEG; null if the browser can't redraw it. */
export async function fitForUpload(picture: Blob): Promise<Blob | null> {
  if (picture.size <= MAX_FILE_BYTES) return picture;
  try {
    const bitmap = await createImageBitmap(picture);
    const scale = fitScale(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const smaller = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.85));
    return smaller && smaller.size <= MAX_FILE_BYTES ? smaller : null;
  } catch {
    return null;
  }
}
