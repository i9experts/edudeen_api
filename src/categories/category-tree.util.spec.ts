import { getAncestorChain, getDescendantIds, getSubtreeHeight, invalidateCategoryTreeCache, nestCategories } from './category-tree.util';

const rows = [
  { _id: 'r', parentId: null },
  { _id: 'a', parentId: 'r' },
  { _id: 'b', parentId: 'a' },
  { _id: 'c', parentId: 'b' },
  { _id: 'z', parentId: 'r' },
  { _id: 'other', parentId: null },
];
const model: any = { find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(rows) })) };

describe('category-tree util', () => {
  beforeEach(() => { invalidateCategoryTreeCache(); model.find.mockClear(); });

  it('getDescendantIds returns the node plus every descendant at any depth', async () => {
    expect((await getDescendantIds(model, 'a')).sort()).toEqual(['a', 'b', 'c']);
    expect((await getDescendantIds(model, 'r')).sort()).toEqual(['a', 'b', 'c', 'r', 'z']);
    expect(await getDescendantIds(model, 'c')).toEqual(['c']);
  });

  it('computes descendants from one cached query', async () => {
    await getDescendantIds(model, 'a');
    await getDescendantIds(model, 'r');
    expect(model.find).toHaveBeenCalledTimes(1);
    invalidateCategoryTreeCache();
    await getDescendantIds(model, 'r');
    expect(model.find).toHaveBeenCalledTimes(2);
  });

  it('getAncestorChain walks up to the root; getSubtreeHeight counts levels below', async () => {
    expect(await getAncestorChain(model, 'c')).toEqual(['c', 'b', 'a', 'r']);
    expect(await getAncestorChain(model, 'nope')).toEqual([]);
    expect(await getSubtreeHeight(model, 'r')).toBe(3);
    expect(await getSubtreeHeight(model, 'c')).toBe(0);
  });

  it('survives a parent cycle in bad data', async () => {
    const cyc: any = { find: () => ({ lean: () => Promise.resolve([{ _id: 'x', parentId: 'y' }, { _id: 'y', parentId: 'x' }]) }) };
    expect((await getDescendantIds(cyc, 'x')).sort()).toEqual(['x', 'y']);
    expect((await getAncestorChain(cyc, 'x')).length).toBeLessThanOrEqual(6);
  });

  it('nestCategories nests any depth and drops orphans', () => {
    const tree = nestCategories([...rows, { _id: 'orph', parentId: 'missing' }] as any);
    expect(tree.map((n) => n._id)).toEqual(['r', 'other']);
    expect(tree[0].children[0].children[0].children[0]._id).toBe('c');
  });
});
