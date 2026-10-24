import { describe, expect, it, vi } from 'vitest';
import { prepareHtmlPreview } from './html-preview.util';

describe('prepareHtmlPreview', () => {
  const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

  it('keeps full HTML layout, styles, and non-ASCII text', async () => {
    const source =
      '<!doctype html><html lang="tr"><head><title>Önizleme</title><style>h1 { color: blue }</style></head><body><h1>Merhaba 🌍</h1></body></html>';
    const result = await prepareHtmlPreview(source, vi.fn());
    const doc = parse(result);
    expect(result.startsWith('<!doctype html>')).toBe(true);
    expect(doc.documentElement.lang).toBe('tr');
    expect(doc.title).toBe('Önizleme');
    expect(doc.querySelector('h1')?.textContent).toBe('Merhaba 🌍');
    expect(doc.head.innerHTML).toContain('h1 { color: blue }');
  });

  it('removes scripts, nested browsing contexts, redirects, base URLs, and event handlers', async () => {
    const html = await prepareHtmlPreview(
      '<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test"><script>parent.test=true</script><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="evil"></object><img src="data:image/png;base64,AA" onerror="alert(1)"><p ONCLICK="alert(1)">Text</p>',
      vi.fn()
    );
    const doc = parse(html);
    expect(doc.querySelector('base, script, iframe, object')).toBeNull();
    expect(doc.querySelector('[onerror], [onclick], [srcdoc]')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(doc.head.firstElementChild?.getAttribute('content')).toContain("default-src 'none'");
  });

  it('resolves relative images, stylesheets, media, and links while deduplicating requests', async () => {
    const resolve = vi.fn(
      async (path: string) => `https://stream.test/?path=${encodeURIComponent(path)}`
    );
    const doc = parse(
      await prepareHtmlPreview(
        '<link rel="stylesheet" href="main.css"><img src="foto & resim.png"><img src="foto & resim.png"><video src="film.mp4" poster="cover.png"></video><a href="other.html">Next</a>',
        resolve
      )
    );
    expect(resolve).toHaveBeenCalledTimes(5);
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(
      'https://stream.test/?path=foto%20%26%20resim.png'
    );
    expect(doc.querySelector('link')?.getAttribute('href')).toContain('main.css');
    expect(doc.querySelector('video')?.getAttribute('poster')).toContain('cover.png');
  });

  it('keeps absolute resources and in-document anchors out of the resolver', async () => {
    const resolve = vi.fn();
    const doc = parse(
      await prepareHtmlPreview(
        '<img src="https://example.test/a.png"><img src="data:image/png;base64,AA"><img src="/root.png"><a href="#section">Jump</a>',
        resolve
      )
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('about:srcdoc#section');
  });

  it('handles broken resources without failing the whole preview and removes unresolved srcset', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('Missing file'));
    const doc = parse(
      await prepareHtmlPreview(
        '<img src="missing.png" srcset="other.png 2x"><h1>Visible</h1>',
        resolve
      )
    );
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('');
    expect(doc.querySelector('[srcset]')).toBeNull();
    expect(doc.querySelector('h1')?.textContent).toBe('Visible');
  });

  it('supports empty documents and preserves an existing viewport', async () => {
    const empty = parse(await prepareHtmlPreview('', vi.fn()));
    expect(empty.body.textContent).toBe('');
    expect(empty.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain(
      'width=device-width'
    );
    const supplied = parse(
      await prepareHtmlPreview('<meta name="viewport" content="width=800"><p>Page</p>', vi.fn())
    );
    expect(supplied.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    expect(supplied.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe(
      'width=800'
    );
  });
});
