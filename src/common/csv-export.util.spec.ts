import { EXPORT_ROW_CAP, toExportCsv } from './csv-export.util';

describe('toExportCsv', () => {
  it('quotes every cell and defuses spreadsheet formulas', () => {
    const { csv } = toExportCsv(['Name', 'Note'], [['=HYPERLINK("http://x")', '+1 555'], ['-2', '@SUM(A1)'], ['say "hi"', 'plain']]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Name","Note"');
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://x"")","\'+1 555"');
    expect(lines[2]).toBe('"\'-2","\'@SUM(A1)"');
    expect(lines[3]).toBe('"say ""hi""","plain"');
  });

  it('keeps all rows and adds no warning when under the cap', () => {
    const out = toExportCsv(['a'], [['1'], ['2']]);
    expect(out.truncated).toBe(false);
    expect(out.rowCount).toBe(2);
    expect(out.csv).not.toMatch(/TRUNCATED/);
  });

  it('cuts at the cap and says so on the first line', () => {
    const rows = Array.from({ length: EXPORT_ROW_CAP + 1 }, (_, i) => [String(i)]);
    const out = toExportCsv(['n'], rows, { label: 'users' });
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(EXPORT_ROW_CAP);
    const lines = out.csv.split('\n');
    expect(lines[0]).toMatch(/TRUNCATED: only the newest 5000 users/);
    expect(lines).toHaveLength(EXPORT_ROW_CAP + 2); // warning + header + rows
  });
});
