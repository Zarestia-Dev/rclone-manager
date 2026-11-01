import { Marked, Tokens } from 'marked';

export interface RcParamInfo {
  name: string;
  description: string;
  /** rclone only marks some parameters as optional, so `false` means "not marked", not "required". */
  optional: boolean;
  /** Set only for calls whose source was checked, see `rc-schema.util.ts`. */
  required?: boolean;
}

/**
 * A top-level `- name - description` bullet; rclone sometimes writes the name in `backticks` or
 * 'quotes'. A name may hold hyphens (`gc-percent`), but one with no space around it is the name's
 * own, while the separator always has a space or a colon.
 */
const PARAM_LINE = /^- [`']?([A-Za-z_][\w.]*(?:-[\w.]+)*)[`']?\s*(?:-|:)\s*(.*)$/;
/**
 * Lines that introduce what a call gives back, in the ways rclone's help phrases it: `Returns:`,
 * `Gives the result:`, `This shows the current versions of rclone:`, `The result is`, or a bare
 * `Returns`. The colon is required unless the whole line is one of the short fixed forms, because
 * a wrapped description line may also begin with "Returns".
 */
const RESULTS_HEADINGS = [
  /\b(?:returns?|results?|gives|shows?|lists?|prints?|reports?|displays?|values)\b[^.]*:$/i,
  /^(?:this takes no parameters and )?(?:returns?|results?)$/i,
  /^the results? (?:is|are)\b[^.]*:?$/i,
];
/** A short line that introduces the parameters: `Parameters`, `This takes the following parameters:`. */
const PARAMS_HEADING = /\b(?:parameters?|takes|arguments?)\b[^.]*:?$/i;
const MAX_HEADING_CHARS = 60;
const EXAMPLE_LINE = /^ {2,}rclone rc ([a-z]+\/[\w/-]+(?:\s.*)?)$/;

/** A markdown snippet as plain text: backslash escapes are undone and inline code loses its backticks. */
export function markdownToPlain(text: string): string {
  return text
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

/**
 * Reads the parameters out of an endpoint's help text. rclone has no schema, only prose, but
 * most calls list their parameters as top-level `- name - description` bullets, and their results
 * the same way under a heading of their own, which is left out. Nested bullets (an option's own
 * fields) are not parameters.
 */
export function parseRcParams(help: string): RcParamInfo[] {
  const params: RcParamInfo[] = [];
  const seen = new Set<string>();
  // A results heading switches the bullets off until a parameters heading switches them back on.
  // Some calls describe their results first (`core/stats`), so a results heading does not end it.
  let listingResults = false;

  for (const line of help.split('\n')) {
    const match = PARAM_LINE.exec(line);
    const text = line.trim();
    if (!match && text) {
      if (RESULTS_HEADINGS.some(heading => heading.test(text))) {
        listingResults = true;
      } else if (text.length <= MAX_HEADING_CHARS && PARAMS_HEADING.test(text)) {
        listingResults = false;
      }
    }
    if (!match || listingResults || seen.has(match[1])) continue;
    seen.add(match[1]);
    params.push({
      name: match[1],
      description: markdownToPlain(match[2]),
      optional: /\boptional\b/i.test(match[2]),
    });
  }
  return params;
}

/** The `rclone rc …` example lines of a help text, without the `rclone rc ` prefix. */
export function extractExamples(help: string): string[] {
  const examples: string[] = [];
  for (const line of help.split('\n')) {
    const match = EXAMPLE_LINE.exec(line);
    if (match && !examples.includes(match[1].trim())) examples.push(match[1].trim());
  }
  return examples;
}

const DOCS_ORIGIN = 'https://rclone.org';

/** Makes a link from rclone's own docs absolute so it can be opened from here. */
export function absoluteDocsHref(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith('#')) return `${DOCS_ORIGIN}/rc/${href}`;
  return `${DOCS_ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`;
}

const markdown = new Marked({
  gfm: true,
  walkTokens(token): void {
    if (token.type === 'link') {
      (token as Tokens.Link).href = absoluteDocsHref((token as Tokens.Link).href);
    }
  },
});

/** The help text as HTML. Angular sanitizes it again when it is bound with `[innerHTML]`. */
export function helpToHtml(help: string): string {
  return markdown.parse(help, { async: false });
}
