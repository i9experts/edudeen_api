/** Annual salary & tax deduction certificate (A4 portrait, pdf-lib standard fonts: WinAnsi text only). */

const pdfText = (s: string | number | null | undefined) =>
  String(s ?? '')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/•/g, '*')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
const money = (n: number) =>
  Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

export interface CertificateInput {
  taxYear: string;
  name: string;
  designation: string | null;
  cnic: string;
  ntn: string;
  months: {
    month: string;
    gross: number;
    taxable: number;
    tax: number;
    cpr: string;
  }[];
}

/** Totals shown on the certificate (exported for tests). */
export function certificateTotals(months: CertificateInput['months']) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    gross: r2(months.reduce((s, m) => s + m.gross, 0)),
    taxable: r2(months.reduce((s, m) => s + m.taxable, 0)),
    tax: r2(months.reduce((s, m) => s + m.tax, 0)),
  };
}

export async function renderSalaryCertificatePdf(
  input: CertificateInput,
): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.09, 0.28, 0.44);
  const ink = rgb(0.08, 0.18, 0.26);
  const slate = rgb(0.36, 0.41, 0.45);
  const M = 48;
  const W = 595 - M * 2;
  let y = 842 - M;
  const text = (
    s: string | number | null | undefined,
    x: number,
    yy: number,
    size = 10,
    f = font,
    color = ink,
  ) => page.drawText(pdfText(s), { x, y: yy, size, font: f, color });
  const right = (
    s: string | number | null | undefined,
    xRight: number,
    yy: number,
    size = 10,
    f = font,
    color = ink,
  ) => {
    const t = pdfText(s);
    page.drawText(t, {
      x: xRight - f.widthOfTextAtSize(t, size),
      y: yy,
      size,
      font: f,
      color,
    });
  };
  const rule = (yy: number) =>
    page.drawLine({
      start: { x: M, y: yy },
      end: { x: M + W, y: yy },
      thickness: 0.7,
      color: rgb(0.88, 0.9, 0.92),
    });

  page.drawRectangle({ x: 0, y: 842 - 6, width: 595, height: 6, color: navy });
  text('EDUDEEN', M, y - 6, 20, bold, navy);
  right('SALARY & TAX CERTIFICATE', M + W, y - 6, 13, bold, ink);
  y -= 22;
  right(`Tax year ${input.taxYear} (July - June)`, M + W, y, 10, font, slate);
  y -= 28;
  text('Employee', M, y, 9, font, slate);
  text(input.name, M + 90, y, 11, bold);
  y -= 16;
  if (input.designation) {
    text('Designation', M, y, 9, font, slate);
    text(input.designation, M + 90, y);
    y -= 16;
  }
  text('CNIC', M, y, 9, font, slate);
  text(input.cnic || '-', M + 90, y);
  text('NTN', M + 280, y, 9, font, slate);
  text(input.ntn || '-', M + 330, y);
  y -= 26;

  const cols = [
    { label: 'Month', x: M },
    { label: 'Gross pay', x: M + 170, right: true },
    { label: 'Taxable income', x: M + 270, right: true },
    { label: 'Tax deducted', x: M + 360, right: true },
    { label: 'CPR', x: M + 375 },
  ];
  for (const c of cols) {
    if (c.right) right(c.label, c.x, y, 9, bold, slate);
    else text(c.label, c.x, y, 9, bold, slate);
  }
  y -= 6;
  rule(y);
  y -= 14;
  for (const m of input.months) {
    text(monthName(m.month), M, y, 9.5);
    right(money(m.gross), M + 170, y, 9.5);
    right(money(m.taxable), M + 270, y, 9.5);
    right(money(m.tax), M + 360, y, 9.5);
    const cpr = pdfText(m.cpr || '-');
    text(
      cpr.length > 30 ? `${cpr.slice(0, 29)}...` : cpr,
      M + 375,
      y,
      8.5,
      font,
      slate,
    );
    y -= 15;
  }
  rule(y + 6);
  y -= 8;
  const t = certificateTotals(input.months);
  text('Total', M, y, 10, bold);
  right(money(t.gross), M + 170, y, 10, bold);
  right(money(t.taxable), M + 270, y, 10, bold);
  right(money(t.tax), M + 360, y, 10, bold);
  y -= 34;
  const note = [
    `This certifies that income tax of PKR ${money(t.tax)} was deducted from the salary of the employee named above for tax year ${input.taxYear}`,
    'and deposited with the Federal Board of Revenue against the CPR numbers listed (where recorded).',
    'Generated from Edudeen payroll records. Amounts in PKR.',
  ];
  for (const l of note) {
    text(l, M, y, 8.5, font, slate);
    y -= 12;
  }
  y -= 36;
  page.drawLine({
    start: { x: M, y },
    end: { x: M + 180, y },
    thickness: 0.7,
    color: slate,
  });
  text('Authorised signatory', M, y - 12, 8.5, font, slate);
  return Buffer.from(await doc.save());
}
