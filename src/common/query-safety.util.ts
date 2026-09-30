import { BadRequestException } from '@nestjs/common';

/**
 * Neutralises CSV/spreadsheet formula injection: a cell that STARTS with = + - @ (or a tab/CR, which some apps
 * strip before evaluating) is executed as a formula when the file is opened in Excel/Sheets/Numbers. Prefixing a
 * single quote makes it plain text. Applied before the normal CSV quoting.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** Escapes regex metacharacters so user input is matched literally (ReDoS / pattern injection). */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A user-supplied search term: a bounded string, or undefined. Objects/arrays (?q[$ne]=x) are dropped. */
export function searchTerm(value: unknown, maxLength = 100): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t ? t.slice(0, maxLength) : undefined;
}

/** A plain string filter value (never an operator object). */
export function plainString(value: unknown, maxLength = 100): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

/** Parses a date query param; an invalid one is a 400 instead of a CastError 500. */
export function parseDateParam(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') throw new BadRequestException(`${field} is not a valid date`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a valid date`);
  return d;
}

/**
 * Bounds an opaque seller-supplied JSON document that is later served publicly (legacy `builderConfig`): total
 * serialized size, nesting depth, per-string length, key names, and dangerous URL schemes anywhere in a string value.
 * It does not try to understand the shape — it only removes the abuse cases (storage bloat, `javascript:`/`data:`
 * links, prototype-pollution-style keys) that a client renderer could otherwise be tricked by.
 */
export function assertSafePublicJson(value: unknown, field: string, { maxBytes = 60_000, maxDepth = 8, maxString = 2000 } = {}): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BadRequestException(`${field} is not valid JSON`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes) {
    throw new BadRequestException(`${field} is too large`);
  }
  const walk = (node: unknown, depth: number) => {
    if (depth > maxDepth) throw new BadRequestException(`${field} is nested too deeply`);
    if (typeof node === 'string') {
      if (node.length > maxString) throw new BadRequestException(`${field} contains a value that is too long`);
      if (/^\s*(javascript|data|vbscript):/i.test(node)) throw new BadRequestException(`${field} contains a link that is not allowed`);
    } else if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k.startsWith('$') || k.includes('.')) {
          throw new BadRequestException(`${field} contains a key that is not allowed`);
        }
        walk(v, depth + 1);
      }
    }
  };
  walk(value, 0);
}
