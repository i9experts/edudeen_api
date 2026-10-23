import { registerDecorator, ValidationOptions } from 'class-validator';

/** A link an admin may attach to a banner / home card: an in-site path ("/?category=maths") or an http(s) URL.
 * Rejects protocol-relative ("//x"), backslashes, control characters and javascript:/data: schemes. */
export function isSafeLinkTarget(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 500) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return false;
  if (v.startsWith('/')) return !v.startsWith('//');
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function IsLinkTarget(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isLinkTarget',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must be an in-site path (starting with /) or an http(s) URL`, ...options },
      validator: { validate: (value: unknown) => isSafeLinkTarget(value) },
    });
}