/* eslint-disable prettier/prettier */
/** One payslip as an A4 portrait PDF (pdf-lib, standard fonts: WinAnsi text only). */

const pdfText = (s: string | number | null | undefined) => String(s ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, '*').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
const money = (n: number) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export async function renderPayslipPdf(input: {
  run: { month: string; status: string };
  line: any;
  profile: { bankName?: string | null; bankAccount?: string | null; cnic?: string | null; designation?: string | null } | null;
}): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const { run, line, profile } = input;
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

  const text = (s: string | number | null | undefined, x: number, yy: number, size = 10, f = font, color = ink) => page.drawText(pdfText(s), { x, y: yy, size, font: f, color });
  const right = (s: string | number | null | undefined, xRight: number, yy: number, size = 10, f = font, color = ink) => {
    const t = pdfText(s);
    page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color });
  };
  const rule = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: M + W, y: yy }, thickness: 0.7, color: rgb(0.88, 0.9, 0.92) });

  // Header
  page.drawRectangle({ x: 0, y: 842 - 6, width: 595, height: 6, color: navy });
  text('EDUDEEN', M, y - 6, 20, bold, navy);
  right('PAYSLIP', M + W, y - 6, 16, bold, ink);
  y -= 24;
  right(monthName(run.month), M + W, y, 11, font, slate);
  text('edudeen.com', M, y, 9, font, slate);
  y -= 22;
  rule(y);
  y -= 18;

  // Person
  const info: [string, string][] = [
    ['Name', line.name ?? line.email ?? ''],
    ['Designation', profile?.designation ?? line.designation ?? '-'],
    ['Type', line.workerType === 'contractor' ? 'Contractor' : 'Employee'],
    ['Days paid', `${line.daysWorked} of ${line.daysInMonth}`],
    ['CNIC', profile?.cnic ?? '-'],
    ['Bank', [profile?.bankName, profile?.bankAccount].filter(Boolean).join(' ') || '-'],
  ];
  info.forEach(([k, v], i) => {
    const col = i % 2;
    const x = M + col * (W / 2);
    if (col === 0 && i > 0) y -= 16;
    text(k, x, y, 9, font, slate);
    text(v, x + 70, y, 10, bold);
  });
  y -= 26;

  // Two columns: earnings | deductions
  const colW = (W - 20) / 2;
  const top = y;
  const section = (title: string, rows: { label: string; amount: number }[], x: number, total: { label: string; amount: number }) => {
    let yy = top;
    page.drawRectangle({ x, y: yy - 6, width: colW, height: 20, color: rgb(0.96, 0.97, 0.98) });
    text(title, x + 8, yy, 10, bold);
    right('PKR', x + colW - 8, yy, 9, font, slate);
    yy -= 22;
    for (const r of rows) {
      const label = pdfText(r.label);
      let l = label;
      while (l.length > 4 && font.widthOfTextAtSize(l, 9.5) > colW - 90) l = l.slice(0, -2);
      text(l === label ? l : `${l}...`, x + 8, yy, 9.5);
      right(money(r.amount), x + colW - 8, yy, 9.5);
      yy -= 15;
    }
    if (!rows.length) { text('None', x + 8, yy, 9.5, font, slate); yy -= 15; }
    yy -= 4;
    page.drawLine({ start: { x, y: yy + 10 }, end: { x: x + colW, y: yy + 10 }, thickness: 0.7, color: rgb(0.8, 0.83, 0.86) });
    text(total.label, x + 8, yy - 2, 10, bold);
    right(money(total.amount), x + colW - 8, yy - 2, 10, bold);
    return yy - 2;
  };
  const yA = section('Earnings', (line.earnings ?? []).map((e: any) => ({ label: e.meta?.count != null && e.kind === 'incentive' ? `${e.label} (${e.meta.count})` : e.label, amount: e.amount })), M, { label: 'Gross pay', amount: line.gross });
  const yB = section('Deductions', (line.deductions ?? []).map((d: any) => ({ label: d.label, amount: d.amount })), M + colW + 20, { label: 'Total deductions', amount: line.totalDeductions });
  y = Math.min(yA, yB) - 30;

  // Net pay
  page.drawRectangle({ x: M, y: y - 12, width: W, height: 36, color: navy });
  page.drawText('NET PAY', { x: M + 14, y: y, size: 12, font: bold, color: rgb(1, 1, 1) });
  const net = `PKR ${money(line.net)}`;
  page.drawText(net, { x: M + W - 14 - bold.widthOfTextAtSize(net, 15), y: y - 1, size: 15, font: bold, color: rgb(1, 1, 1) });
  y -= 44;

  // Employer contributions and tax year-to-date
  const notes: string[] = [];
  if ((line.employer ?? []).length) notes.push(`Employer contributions (not deducted from you): ${(line.employer as any[]).map((e) => `${e.label} ${money(e.amount)}`).join(', ')}.`);
  if (line.tax) {
    const taxThis = (line.deductions ?? []).filter((d: any) => d.kind === 'income_tax').reduce((s: number, d: any) => s + d.amount, 0);
    notes.push(`Tax year to date (incl. this month): taxable income ${money(line.tax.ytdTaxable + line.taxableIncome)}, salary tax ${money(line.tax.ytdTax + taxThis)}. Projected annual taxable income ${money(line.tax.projectedAnnual)}.`);
  }
  if (line.paid?.at) notes.push(`Paid on ${new Date(line.paid.at).toISOString().slice(0, 10)}.`);
  for (const n of notes) {
    const words = pdfText(n).split(' ');
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, 9) > W) { text(cur, M, y, 9, font, slate); y -= 13; cur = w; } else cur = next;
    }
    if (cur) { text(cur, M, y, 9, font, slate); y -= 17; }
  }

  text('This payslip is generated by Edudeen payroll and does not need a signature.', M, M - 10, 8, font, slate);
  right(`Generated ${new Date().toISOString().slice(0, 10)}`, M + W, M - 10, 8, font, slate);
  return Buffer.from(await doc.save());
}
