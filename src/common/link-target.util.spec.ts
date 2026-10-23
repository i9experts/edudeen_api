import { isSafeLinkTarget } from './link-target.util';

describe('isSafeLinkTarget', () => {
  it('accepts in-site paths and http(s) urls', () => {
    expect(isSafeLinkTarget('/?category=maths')).toBe(true);
    expect(isSafeLinkTarget('/?campaign=65f0c0ffee&x=1')).toBe(true);
    expect(isSafeLinkTarget('https://example.com/sale')).toBe(true);
  });
  it('rejects unsafe or malformed links', () => {
    for (const v of ['//evil.com', 'javascript:alert(1)', 'data:text/html,x', '/a\\b', '', '   ', 'ftp://x.com', '/x\ny', 5, null]) {
      expect(isSafeLinkTarget(v as any)).toBe(false);
    }
  });
});