import { lookupStores } from './store-lookup.util';

const stores = [
  { id: '1', name: 'Edudeen Books', slug: 'edudeen-books', email: 'ali.khan@gmail.com', ownerName: 'Ali Khan' },
  { id: '2', name: 'Noor Academy', slug: 'noor-academy', email: 'sara@yahoo.com', ownerName: 'Sara Ahmed' },
  { id: '3', name: 'Al Huda Stationery', slug: 'al-huda' },
];
const ids = (q: string) => lookupStores(stores, q).map(s => s.id);

describe('lookupStores', () => {
  it('one letter matches the start of any word', () => {
    expect(ids('n')).toEqual(['2']);
    expect(ids('s')).toEqual(['3', '2']); // Stationery, and Sara (owner name)
  });
  it('matches part of a word', () => expect(ids('cadem')).toEqual(['2']));
  it('tolerates wrong spelling', () => {
    expect(ids('edudin')).toEqual(['1']);
    expect(ids('nour acadmy')).toEqual(['2']);
    expect(ids('stationry')).toEqual(['3']);
  });
  it('joined/split spelling', () => expect(ids('edu deen')).toEqual(['1']));
  it('finds the store by the seller e-mail (full, partial or a part) or owner name', () => {
    expect(ids('ali.khan@gmail.com')).toEqual(['1']);
    expect(ids('sara@y')).toEqual(['2']);
    expect(ids('yahoo')).toEqual(['2']);
    expect(ids('sarah ahmad')).toEqual(['2']);
  });
  it('unrelated text matches nothing', () => expect(ids('zzzzqq')).toEqual([]));
  it('empty query returns nothing', () => expect(ids('  ')).toEqual([]));
});
