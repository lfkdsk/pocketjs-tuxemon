/** Minimal menu surface used by the weather overlay's render policy. */
export interface WeatherOverlayMenu {
  isOpen(): boolean;
}

/** Weather is a world effect, so sibling UI menus must cover it completely. */
export function weatherOverlaySuspended(
  demoMenu: WeatherOverlayMenu | null,
  saveMenu: WeatherOverlayMenu | null,
  ...more: (WeatherOverlayMenu | null)[]
): boolean {
  if (demoMenu?.isOpen() ?? false) return true;
  if (saveMenu?.isOpen() ?? false) return true;
  return more.some((menu) => menu?.isOpen() ?? false);
}
