import { splitEditForReview, overlayPendingEdit, buildEditDiff } from './product-edit-review.util';

describe('product edit review', () => {
  const live = { status: 'active', approvedAt: new Date(), name: 'Old title here', description: 'Same description text', images: ['a.jpg'] };

  it('holds changed content of a live listing, applies offers/status immediately, ignores unchanged fields', () => {
    const r = splitEditForReview(live as any, { name: 'New title here', description: live.description, images: ['a.jpg'], status: 'active', campaignIds: ['c1'] });
    expect(r.hold).toBe(true);
    expect(r.held).toEqual({ name: 'New title here' });
    expect(r.immediate).toEqual({ status: 'active', campaignIds: ['c1'] });
  });

  it('does not hold edits of a draft or an unapproved listing', () => {
    expect(splitEditForReview({ status: 'draft', approvedAt: null } as any, { name: 'x', status: 'draft' }).hold).toBe(false);
    expect(splitEditForReview({ status: 'pending_review', approvedAt: null } as any, { name: 'x' }).hold).toBe(false);
  });

  it('overlay shows the pending values to the seller and hides the raw pendingEdit', () => {
    const out: any = overlayPendingEdit({ ...live, pendingEdit: { changes: { name: 'New title here' }, submittedAt: new Date(), fields: ['name'] } } as any);
    expect(out.name).toBe('New title here');
    expect(out.pendingEdit).toBeUndefined();
    expect(out.pendingEditInfo.fields).toEqual(['name']);
  });

  it('diff shows a held price against the live variant', () => {
    const rows = buildEditDiff(live as any, { __price: 900 }, { variant: { price: 1200, currency: 'PKR' } });
    expect(rows[0]).toMatchObject({ label: 'Price', before: 'PKR 1,200', after: 'PKR 900' });
  });

  it('overlay drops variant-level price keys from the product', () => {
    const out: any = overlayPendingEdit({ ...live, pendingEdit: { changes: { __price: 900 }, submittedAt: new Date() } } as any);
    expect(out.__price).toBeUndefined();
  });

  it('diff shows held per-variant prices with their options', () => {
    const rows = buildEditDiff(live as any, { __variants: { v1: { price: 500 } } }, { variant: { currency: 'PKR' }, variants: [{ _id: 'v1', price: 600, options: [{ name: 'Size', value: 'A4' }] }] });
    expect(rows[0]).toMatchObject({ label: 'Price (A4)', before: 'PKR 600', after: 'PKR 500' });
  });

  it('diff lists before/after and hides internal keys', () => {
    const rows = buildEditDiff(live as any, { name: 'New title here', slug: 'new-title' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Title', before: 'Old title here', after: 'New title here' });
  });
});
