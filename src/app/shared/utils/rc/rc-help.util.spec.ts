import { describe, it, expect } from 'vitest';
import {
  absoluteDocsHref,
  extractExamples,
  helpToHtml,
  markdownToPlain,
  parseRcParams,
} from './rc-help.util';

const LIST_HELP = `This takes the following parameters:

- fs - a remote name string e.g. "drive:"
- remote - a path within that remote e.g. "dir"
- opt - a dictionary of options to control the listing (optional)
    - recurse - If set recurse directories
    - noModTime - If set return modification time

Returns:

- list
    - This is an array of objects as described in the lsjson command

See the [lsjson](/commands/rclone_lsjson/) command for more information.`;

const STATUS_HELP = `Parameters:

- jobid - id of the job (integer).

Results:

- finished - boolean
- duration - time in seconds that the job ran for`;

const PROSE_HELP = `Refresh the directory cache.

    rclone rc vfs/refresh

Otherwise pass directories in as dir=path, e.g.

    rclone rc vfs/refresh dir=home/junk dir2=data/misc

    rclone rc vfs/refresh dir=home/junk`;

describe('rc-help.util', () => {
  describe('parseRcParams', () => {
    it('reads top-level bullets and stops at Returns', () => {
      expect(parseRcParams(LIST_HELP).map(p => p.name)).toEqual(['fs', 'remote', 'opt']);
    });

    it('reads names that rclone writes in backticks or quotes', () => {
      const help = [
        'This takes the following parameters',
        '',
        '- `fs` - select the VFS in use (optional)',
        "- 'id' - a numeric ID",
        '- `expiry` - a new expiry time',
      ].join('\n');
      expect(parseRcParams(help).map(p => p.name)).toEqual(['fs', 'id', 'expiry']);
      expect(parseRcParams(help)[0].optional).toBe(true);
    });

    it('keeps a hyphen that is part of the name', () => {
      const help = [
        'Parameters:',
        '',
        '- gc-percent - int',
        '- `mem-limit`: bytes',
        '- fs-name-with-more - a name',
        '- plain -dashed description',
      ].join('\n');
      expect(parseRcParams(help)).toEqual([
        { name: 'gc-percent', description: 'int', optional: false },
        { name: 'mem-limit', description: 'bytes', optional: false },
        { name: 'fs-name-with-more', description: 'a name', optional: false },
        { name: 'plain', description: 'dashed description', optional: false },
      ]);
    });

    it('stops at Results too and keeps the description', () => {
      const params = parseRcParams(STATUS_HELP);
      expect(params).toEqual([
        { name: 'jobid', description: 'id of the job (integer).', optional: false },
      ]);
    });

    it('marks parameters that say they are optional', () => {
      const params = parseRcParams(LIST_HELP);
      expect(params.find(p => p.name === 'opt')?.optional).toBe(true);
      expect(params.find(p => p.name === 'fs')?.optional).toBe(false);
    });

    it('stops at every way rclone introduces the results', () => {
      const headings = [
        'Returns:',
        'Returns a JSON object:',
        'Returns the following values:',
        'This returns all available stats:',
        'This returns the following values:',
        'This takes no parameters and returns:',
        'Gives the result:',
        'Results:',
      ];
      for (const heading of headings) {
        const params = parseRcParams(`- fs - a remote\n\n${heading}\n\n- version - a result`);
        expect(
          params.map(p => p.name),
          heading
        ).toEqual(['fs']);
      }
    });

    it('does not stop at the line that introduces the parameters', () => {
      const help = 'This takes the following parameters:\n\n- fs - a remote\n- remote - a path';
      expect(parseRcParams(help).map(p => p.name)).toEqual(['fs', 'remote']);
    });

    it('reads the parameters of a call that describes its results first', () => {
      const help = `This returns all available stats:

    rclone rc core/stats

Parameters

- group - name of the stats group (string, optional)
- short - if true will not return the transferring arrays (boolean, optional)

Returns the following values:

- bytes - total transferred`;
      expect(parseRcParams(help).map(p => p.name)).toEqual(['group', 'short']);
    });

    it('does not take the results of an info call for parameters', () => {
      const help = `This shows the current versions of rclone, Go and the OS:

- version - rclone version
- os - OS in use`;
      expect(parseRcParams(help)).toEqual([]);
    });

    it('knows a results heading without a colon, but only the short fixed forms', () => {
      const stat = '- fs - a remote\n\nThe result is\n\n- item - an object';
      expect(parseRcParams(stat).map(p => p.name)).toEqual(['fs']);
      const bare = 'This takes no parameters and returns\n\n- types - a list';
      expect(parseRcParams(bare)).toEqual([]);
      const wrapped =
        'Returns an object where keys are blocks and values are an\n\n- blocks - which';
      expect(parseRcParams(wrapped).map(p => p.name)).toEqual(['blocks']);
    });

    it('lists parameters that no heading introduces', () => {
      const help = 'Pass a clear string and rclone will obscure it:\n\n- clear - the string';
      expect(parseRcParams(help).map(p => p.name)).toEqual(['clear']);
    });

    it('finds no parameters in a call that only lists its results', () => {
      const help = 'Shows the version.\n\nThis returns:\n\n- version - the version\n- os - the OS';
      expect(parseRcParams(help)).toEqual([]);
    });

    it('never treats a bullet as a heading', () => {
      expect(parseRcParams('- a - returns:\n- b - two').map(p => p.name)).toEqual(['a', 'b']);
    });

    it('shows the description as plain text', () => {
      const [param] = parseRcParams('- parameters - a map of \\{ "key": "value" \\} pairs');
      expect(param.description).toBe('a map of { "key": "value" } pairs');
    });

    it('accepts a colon after the name', () => {
      expect(parseRcParams('- blocks: optional string of blocks')).toEqual([
        { name: 'blocks', description: 'optional string of blocks', optional: true },
      ]);
    });

    it('does not stop at a sentence that merely starts with Returns', () => {
      const help = 'Returns an object where keys are blocks.\n\n- blocks - which ones';
      expect(parseRcParams(help).map(p => p.name)).toEqual(['blocks']);
    });

    it('ignores duplicates and returns nothing for prose-only help', () => {
      expect(parseRcParams('- a - one\n- a - two').map(p => p.description)).toEqual(['one']);
      expect(parseRcParams(PROSE_HELP)).toEqual([]);
      expect(parseRcParams('')).toEqual([]);
    });
  });

  describe('markdownToPlain', () => {
    it('undoes the backslash escapes rclone writes around braces', () => {
      expect(markdownToPlain('a map of \\{ "key": "value" \\} pairs')).toBe(
        'a map of { "key": "value" } pairs'
      );
    });

    it('drops the backticks of inline code and keeps what is inside', () => {
      expect(markdownToPlain('Defaults to `--transfers` if not set.')).toBe(
        'Defaults to --transfers if not set.'
      );
      expect(markdownToPlain('format `author`/`plugin_name`.')).toBe('format author/plugin_name.');
    });

    it('keeps a real backslash that escapes nothing', () => {
      expect(markdownToPlain('path C:\\Users')).toBe('path C:\\Users');
    });

    it('leaves plain text alone and trims it', () => {
      expect(markdownToPlain('  a remote name  ')).toBe('a remote name');
    });
  });

  describe('extractExamples', () => {
    it('collects each distinct example without the prefix', () => {
      expect(extractExamples(PROSE_HELP)).toEqual([
        'vfs/refresh',
        'vfs/refresh dir=home/junk dir2=data/misc',
        'vfs/refresh dir=home/junk',
      ]);
    });

    it('ignores lines that are not examples', () => {
      expect(extractExamples('run rclone rc core/version now')).toEqual([]);
    });
  });

  describe('absoluteDocsHref', () => {
    it('points relative links at rclone.org', () => {
      expect(absoluteDocsHref('/commands/rclone_copy/')).toBe(
        'https://rclone.org/commands/rclone_copy/'
      );
      expect(absoluteDocsHref('#option-blocks')).toBe('https://rclone.org/rc/#option-blocks');
    });

    it('leaves absolute links alone', () => {
      expect(absoluteDocsHref('https://example.com/x')).toBe('https://example.com/x');
      expect(absoluteDocsHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    });
  });

  describe('helpToHtml', () => {
    it('renders links with absolute hrefs, lists and code blocks', () => {
      const html = helpToHtml(LIST_HELP + '\n\n    rclone rc operations/list fs=drive:');
      expect(html).toContain('href="https://rclone.org/commands/rclone_lsjson/"');
      expect(html).toContain('<li>');
      expect(html).toContain('<pre><code>');
    });

    it('does not leak link rewrites between calls', () => {
      expect(helpToHtml('[a](/x/)')).toContain('https://rclone.org/x/');
      expect(helpToHtml('[a](https://e.com)')).toContain('href="https://e.com"');
    });
  });
});
