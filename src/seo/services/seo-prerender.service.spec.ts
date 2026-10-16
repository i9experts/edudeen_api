/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- light unit test */
import { SeoPrerenderService, STATIC_PAGES, esc } from './seo-prerender.service';

describe('SeoPrerenderService (crawler HTML)', () => {
  const svc = new SeoPrerenderService({ repositories: {} } as any, {} as any, {} as any, {} as any);

  it('escapes HTML in every text value', () => {
    expect(esc('<script>"a"&</script>')).toBe('&lt;script&gt;&quot;a&quot;&amp;&lt;/script&gt;');
  });

  it('renders one h1, canonical, og:image and JSON-LD in the initial HTML', () => {
    const html = svc.render({
      title: 'T <x>', description: 'D', canonical: 'https://edudeen.com/c/maths', ogImage: 'https://edudeen.com/og-default.png', ogType: 'website',
      noindex: false, jsonLd: [{ '@context': 'https://schema.org', '@type': 'BreadcrumbList', name: '</script><b>' }], body: '<h1>Maths</h1>',
    });
    expect(html).toContain('<link rel="canonical" href="https://edudeen.com/c/maths">');
    expect(html).toContain('<title>T &lt;x&gt;</title>');
    expect(html).toContain('og:image');
    expect(html.match(/<h1>/g)).toHaveLength(1);
    // JSON-LD cannot break out of its script tag
    expect(html).not.toContain('</script><b>');
    expect(html).toContain('index,follow');
  });

  it('noindex pages say so', () => {
    const html = svc.render({ title: 't', description: 'd', canonical: 'https://edudeen.com/x', ogImage: null, ogType: 'website', noindex: true, jsonLd: [], body: '' });
    expect(html).toContain('noindex,follow');
  });

  it('static pages are all public, absolute-path routes of the web app', () => {
    for (const [slug, p] of Object.entries(STATIC_PAGES)) {
      expect(p.path).toBe(`/${slug}`);
      expect(p.title.length).toBeGreaterThan(5);
      expect(p.description.length).toBeLessThan(200);
    }
  });
});
