/** Prepare a static document for an opaque-origin, sandboxed srcdoc iframe. */
export async function prepareHtmlPreview(
  source: string,
  resolveRelativeUrl: (path: string) => Promise<string>
): Promise<string> {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  // Keep HTML/CSS presentation while removing active content and document redirects.
  doc
    .querySelectorAll('script, iframe, frame, frameset, object, embed, base, meta[http-equiv]')
    .forEach(element => element.remove());
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc')
        element.removeAttribute(attribute.name);
    }
  }

  const cache = new Map<string, Promise<string>>();
  const resolve = (url: string): Promise<string> => {
    if (!url || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(url)) return Promise.resolve(url);
    if (url.startsWith('#')) return Promise.resolve(`about:srcdoc${url}`);
    let pending = cache.get(url);
    if (!pending) {
      pending = resolveRelativeUrl(url).catch(() => '');
      cache.set(url, pending);
    }
    return pending;
  };
  const resources: [string, string][] = [
    ['img[src], video[src], audio[src], source[src]', 'src'],
    ['video[poster]', 'poster'],
    ['link[rel~="stylesheet"][href], a[href]', 'href'],
  ];
  await Promise.all(
    resources.flatMap(([selector, attribute]) =>
      [...doc.querySelectorAll(selector)].map(async element => {
        element.setAttribute(attribute, await resolve(element.getAttribute(attribute) ?? ''));
      })
    )
  );
  // srcset needs a dedicated parser. Do not let unresolved candidates request app URLs.
  doc.querySelectorAll('[srcset]').forEach(element => element.removeAttribute('srcset'));
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content =
    "default-src 'none'; img-src http: https: data: blob: local-asset: rclone:; style-src 'unsafe-inline' http: https: local-asset: rclone:; font-src http: https: data: local-asset: rclone:; media-src http: https: data: blob: local-asset: rclone:; form-action 'none'; base-uri 'none'";
  const referrer = doc.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  const defaults = doc.createElement('style');
  defaults.textContent =
    ':root { color-scheme: light; } body { background: Canvas; color: CanvasText; }';
  doc.head.prepend(policy, referrer, defaults);
  if (!doc.querySelector('meta[name="viewport"]')) {
    const viewport = doc.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    doc.head.append(viewport);
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
