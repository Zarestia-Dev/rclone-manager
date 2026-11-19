/** The desktop accent colour and the text colours derived from it, as CSS values. */
export interface AccentPalette {
  /** Fills, such as a filled button, as `#rrggbb` and as `r, g, b`. */
  background: string;
  backgroundRgb: string;
  /** Text and icons on a light background, as `#rrggbb`. */
  light: string;
  /** Text and icons on a dark background. */
  dark: string;
}

type Rgb = [number, number, number];

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

// sRGB <-> OKLab, from https://bottosson.github.io/posts/oklab/
function toOklab([red, green, blue]: Rgb): Rgb {
  const [r, g, b] = [red, green, blue].map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([lightness, a, b]: Rgb): Rgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(c => Math.min(Math.max(fromLinear(c), 0), 1)) as Rgb;
}

const to255 = (rgb: Rgb): Rgb => rgb.map(c => Math.round(c * 255)) as Rgb;
const toHex = (rgb: Rgb): string =>
  '#' +
  to255(rgb)
    .map(c => c.toString(16).padStart(2, '0'))
    .join('');

/**
 * The palette for a desktop accent colour given as `#rrggbb`, or null for anything else. Like
 * libadwaita, text keeps the accent's hue but at most OKLab lightness 0.5 on light backgrounds
 * and at least 0.85 on dark ones, so it stays readable whatever accent the desktop picks.
 */
export function accentPalette(color: string | null | undefined): AccentPalette | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color?.trim() ?? '');
  if (!match) return null;
  const rgb = match.slice(1).map(hex => parseInt(hex, 16) / 255) as Rgb;
  const [lightness, a, b] = toOklab(rgb);
  const light = fromOklab([Math.min(lightness, 0.5), a, b]);
  const dark = fromOklab([Math.max(lightness, 0.85), a, b]);
  return {
    background: toHex(rgb),
    backgroundRgb: to255(rgb).join(', '),
    light: toHex(light),
    dark: toHex(dark),
  };
}
