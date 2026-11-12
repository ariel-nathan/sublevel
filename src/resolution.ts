export interface Resolution {
  width: number;
  height: number;
}

/** Low internal render size with a fixed height, keeping the window's aspect ratio. */
export function internalResolution(
  windowWidth: number,
  windowHeight: number,
  targetHeight: number,
): Resolution {
  const aspect = windowHeight > 0 ? windowWidth / windowHeight : 1;
  return {
    width: Math.max(1, Math.round(targetHeight * aspect)),
    height: targetHeight,
  };
}
