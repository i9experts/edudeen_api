// Canonical, ordered list of school classes used for the "Class" filter, a product's
// optional classFrom..classTo range and a child's class. Mirrored in the web app:
// edudeen_web/src/constants/classLevels.ts (keep both in sync).

export const CLASS_LEVELS = [
  { value: 'nursery', label: 'Nursery' },
  { value: 'prep', label: 'Prep' },
  { value: 'kg', label: 'KG' },
  { value: 'class-1', label: 'Class 1' },
  { value: 'class-2', label: 'Class 2' },
  { value: 'class-3', label: 'Class 3' },
  { value: 'class-4', label: 'Class 4' },
  { value: 'class-5', label: 'Class 5' },
  { value: 'class-6', label: 'Class 6' },
  { value: 'class-7', label: 'Class 7' },
  { value: 'class-8', label: 'Class 8' },
  { value: 'class-9', label: 'Class 9' },
  { value: 'class-10', label: 'Class 10' },
  { value: 'class-11', label: 'Class 11' },
  { value: 'class-12', label: 'Class 12' },
  { value: 'o-level', label: 'O Level' },
  { value: 'a-level', label: 'A Level' },
  { value: 'university', label: 'University' },
] as const;

export const CLASS_VALUES: string[] = CLASS_LEVELS.map((c) => c.value);

export function classIndex(value: unknown): number {
  return typeof value === 'string' ? CLASS_VALUES.indexOf(value) : -1;
}

/** Coarse Product.educationLevel -> the classes it covers (so old products without class data still match). */
export const LEVEL_CLASSES: Record<string, string[]> = {
  preschool: ['nursery', 'prep', 'kg'],
  primary_school: ['class-1', 'class-2', 'class-3', 'class-4', 'class-5'],
  middle_school: ['class-6', 'class-7', 'class-8'],
  secondary_school: ['class-9', 'class-10', 'o-level'],
  college: ['class-11', 'class-12', 'a-level'],
  university: ['university'],
};

/** The coarse level a class belongs to (used to derive a child's educationLevel). */
export function levelForClass(value: string): string | null {
  for (const [level, classes] of Object.entries(LEVEL_CLASSES)) if (classes.includes(value)) return level;
  return null;
}

/** Whether a product covers `cls`: by its class range when set, else by its coarse level. */
export function productCoversClass(
  p: { classFrom?: string | null; classTo?: string | null; educationLevel?: string | null; normalizedCustomLevel?: string | null },
  cls: string,
): boolean {
  const i = classIndex(cls);
  if (i < 0) return false;
  if (p.classFrom || p.classTo) {
    const from = classIndex(p.classFrom ?? p.classTo);
    const to = classIndex(p.classTo ?? p.classFrom);
    return from >= 0 && to >= 0 && from <= i && i <= to;
  }
  if (p.educationLevel && (LEVEL_CLASSES[p.educationLevel] ?? []).includes(cls)) return true;
  return p.educationLevel === 'other' && !!p.normalizedCustomLevel && `grade-${cls.replace('class-', '')}` === p.normalizedCustomLevel && cls.startsWith('class-');
}

/** Mongo filter equivalent of productCoversClass, or null for an unknown class value. */
export function classFilter(cls: string): Record<string, any> | null {
  const i = classIndex(cls);
  if (i < 0) return null;
  const startsAtOrBefore = CLASS_VALUES.slice(0, i + 1);
  const endsAtOrAfter = CLASS_VALUES.slice(i);
  const levels = Object.entries(LEVEL_CLASSES).filter(([, cs]) => cs.includes(cls)).map(([l]) => l);
  const legacy: Record<string, any>[] = [{ educationLevel: { $in: levels } }];
  if (cls.startsWith('class-')) {
    legacy.push({ educationLevel: 'other', normalizedCustomLevel: `grade-${cls.slice(6)}` });
  }
  return {
    $or: [
      { classFrom: { $in: startsAtOrBefore }, classTo: { $in: endsAtOrAfter } },
      // one-sided data (only classFrom or only classTo) = that single class
      { classFrom: cls, classTo: null },
      { classTo: cls, classFrom: null },
      { classFrom: null, classTo: null, $or: legacy },
    ],
  };
}

/** Resolves a stored/typed value (`class-3`, `Class 3`, `Grade 3`, `3rd class`, `KG`) to a canonical class value, else null. */
export function canonicalClass(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (CLASS_VALUES.includes(t)) return t;
  const byLabel = CLASS_LEVELS.find((c) => c.label.toLowerCase() === t || c.value.replace('-', ' ') === t);
  if (byLabel) return byLabel.value;
  const m = t.match(/^(?:(?:class|grade)\s*-?\s*(\d{1,2})|(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:class|grade))$/);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return n >= 1 && n <= 12 ? `class-${n}` : null;
}

/** "Class 2-4", "Class 3", "Nursery - KG". null when no range is set. */
export function classRangeLabel(from?: string | null, to?: string | null): string | null {
  const f = from ?? to;
  const t = to ?? from;
  if (!f || !t) return null;
  const label = (v: string) => CLASS_LEVELS.find((c) => c.value === v)?.label ?? v;
  if (f === t) return label(f);
  const num = (v: string) => (v.startsWith('class-') ? v.slice(6) : null);
  return num(f) && num(t) ? `Class ${num(f)}-${num(t)}` : `${label(f)} - ${label(t)}`;
}

/** Validates a class range from a request body. Only keys present are returned; throws on bad values / from > to. */
export function cleanClassRange(body: Record<string, unknown>, bad: (msg: string) => Error): { classFrom?: string | null; classTo?: string | null } {
  const out: { classFrom?: string | null; classTo?: string | null } = {};
  for (const k of ['classFrom', 'classTo'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null || v === '') { out[k] = null; continue; }
    if (typeof v !== 'string' || !CLASS_VALUES.includes(v)) throw bad(`${k} must be one of: ${CLASS_VALUES.join(', ')}`);
    out[k] = v;
  }
  if (out.classFrom && out.classTo && classIndex(out.classFrom) > classIndex(out.classTo)) {
    throw bad('classFrom cannot be after classTo');
  }
  return out;
}
