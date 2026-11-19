import axe from 'axe-core';

/**
 * Rules that need a whole rendered page or real layout. A single component in jsdom has
 * neither (no CSS boxes, no document around it), so they would only report noise here.
 */
const PAGE_LEVEL_RULES = [
  'color-contrast',
  'landmark-one-main',
  'page-has-heading-one',
  'region',
  'bypass',
  'document-title',
  'html-has-lang',
];

/** The axe-core violations inside `element`, one readable line each, for `toEqual([])`. */
export async function axeViolations(element: Element): Promise<string[]> {
  const result = await axe.run(element, {
    rules: Object.fromEntries(PAGE_LEVEL_RULES.map(id => [id, { enabled: false }])),
    resultTypes: ['violations'],
  });
  return result.violations.map(
    violation =>
      `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  );
}
