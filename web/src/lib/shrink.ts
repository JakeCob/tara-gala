// TG-52: a picture small enough to share on a trip (the API takes up to 5 MB). Phone photos of tickets can be bigger,
// so those are redrawn as a JPEG no wider or taller than 2400 px, which keeps QR codes and booking numbers readable.

import { MAX_FILE_BYTES } from "./trip.ts";

export const MAX_SIDE = 2400;
export const PHOTO_SIDE = 1600; // trip photos: about 300 KB each, so 300 fit well inside Storage's free 1 GB
export const AVATAR_SIDE = 256; // TG-58: a profile photo, shown at 40 px

/** The scale that fits w by h inside MAX_SIDE, never enlarging. */
export function fitScale(w: number, h: number, maxSide = MAX_SIDE): number {
  return Math.min(1, maxSide / Math.max(w, h, 1));
}

/** The largest square in a w by h picture. Centred across; on a tall picture a third of the way down, so a face isn't cut. */
export function squareCrop(w: number, h: number): { sx: number; sy: number; side: number } {
  const side = Math.min(w, h);
  return { sx: Math.round((w - side) / 2), sy: Math.round((h - side) / 3), side };
}

/** A trip photo, always redrawn as a JPEG no bigger than 1600 px (PR 4); null if the browser can't redraw it. */
export async function fitPhoto(picture: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(picture);
    const scale = fitScale(bitmap.width, bitmap.height, PHOTO_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return null; // without a drawing, toBlob would give a blank picture
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const photo = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.82));
    canvas.width = 0; // iOS caps total canvas memory: free it before the next photo in a batch
    return photo && photo.size <= MAX_FILE_BYTES ? photo : null;
  } catch {
    return null;
  }
}

/** A profile photo, always redrawn as a square JPEG no bigger than 256 px, which drops its location data; null if the browser can't redraw it. */
export async function fitAvatar(picture: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(picture);
    const { sx, sy, side } = squareCrop(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(AVATAR_SIDE, side);
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const avatar = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.8));
    canvas.width = 0;
    return avatar;
  } catch {
    return null;
  }
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
