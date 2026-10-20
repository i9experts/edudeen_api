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

  it('diff lists before/after and hides internal keys', () => {
    const rows = buildEditDiff(live as any, { name: 'New title here', slug: 'new-title' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Title', before: 'Old title here', after: 'New title here' });
  });
});
