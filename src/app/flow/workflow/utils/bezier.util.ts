export interface Point {
  x: number;
  y: number;
}

/** The two control points of the curve between two sockets: the source pulls right, the target left. */
function controlPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature: number
): { c1: Point; c2: Point } {
  const offset = Math.max(Math.abs(x2 - x1) * curvature, 40);
  return { c1: { x: x1 + offset, y: y1 }, c2: { x: x2 - offset, y: y2 } };
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
  const { c1, c2 } = controlPoints(x1, y1, x2, y2, curvature);
  return `M ${x1} ${y1} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${x2} ${y2}`;
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
  const { c1, c2 } = controlPoints(x1, y1, x2, y2, curvature);
  // B(0.5) = (P0 + 3·P1 + 3·P2 + P3) / 8
  return { x: (x1 + 3 * c1.x + 3 * c2.x + x2) / 8, y: (y1 + 3 * c1.y + 3 * c2.y + y2) / 8 };
}
