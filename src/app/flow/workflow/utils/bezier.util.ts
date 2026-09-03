export interface Point {
  x: number;
  y: number;
}

/**
 * Generates an SVG cubic bezier path string connecting two socket coordinates.
 * `(x1, y1)` is the source port position, `(x2, y2)` is the target port position.
 */
export function generateCubicBezierPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature = 0.5
): string {
  const dx = Math.abs(x2 - x1);
  const offset = Math.max(dx * curvature, 40);

  // Source control point extends rightwards
  const cx1 = x1 + offset;
  const cy1 = y1;

  // Target control point extends leftwards
  const cx2 = x2 - offset;
  const cy2 = y2;

  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

/**
 * Calculates the midpoint coordinates of a cubic bezier curve (at t = 0.5)
 * for placing delete buttons, labels, or flow badges.
 */
export function getCubicBezierMidpoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature = 0.5
): Point {
  const dx = Math.abs(x2 - x1);
  const offset = Math.max(dx * curvature, 40);

  const cx1 = x1 + offset;
  const cy1 = y1;
  const cx2 = x2 - offset;
  const cy2 = y2;

  const t = 0.5;
  const mt = 1 - t;

  // B(t) = (1-t)^3 * P0 + 3(1-t)^2*t * P1 + 3(1-t)*t^2 * P2 + t^3 * P3
  const x =
    Math.pow(mt, 3) * x1 +
    3 * Math.pow(mt, 2) * t * cx1 +
    3 * mt * Math.pow(t, 2) * cx2 +
    Math.pow(t, 3) * x2;

  const y =
    Math.pow(mt, 3) * y1 +
    3 * Math.pow(mt, 2) * t * cy1 +
    3 * mt * Math.pow(t, 2) * cy2 +
    Math.pow(t, 3) * y2;

  return { x, y };
}
