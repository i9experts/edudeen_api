import { findContactInfo, scanListingText } from './contact-info.util';

const hits = (s: string) => findContactInfo(s).map((m) => m.type);

describe('findContactInfo', () => {
  it.each([
    ['Call 0300-1234567 now', 'phone'],
    ['whatsapp 03001234567', 'phone'],
    ['+92 300 1234567 for orders', 'phone'],
    ['0092 321 7654321', 'phone'],
    ['92-345-1234567', 'phone'],
    ['UAE office +971 50 123 4567', 'phone'],
    ['Lahore office 042-35761234', 'phone'],
    ['mail me: ali.khan@gmail.com', 'email'],
    ['ali (at) gmail (dot) com', 'email'],
    ['https://wa.me/923001234567', 'whatsapp'],
    ['Message me on WhatsApp', 'whatsapp'],
    ['join t.me/edudeen_books', 'telegram'],
    ['واٹس ایپ پر رابطہ کریں', 'whatsapp'],
  ])('flags %s', (text, type) => {
    expect(hits(text)).toContain(type);
  });

  it.each([
    'ISBN 978-3-16-148410-0',
    'ISBN-13: 9783161484100',
    'ISBN 0-306-40615-2',
    'Only Rs 1,500 (was Rs 3,000)',
    'Price: 1200 PKR, 45 USD',
    'Published 2024, second edition 2025',
    '320 pages, 12 chapters, 450 worksheets',
    'Class 10 Physics, Grade 5 to 8, 3rd edition',
    '2024-2025 session, 100% colour',
    'Pack of 30 / 12 months / 03:30 pm class',
    'Edudeen Noorani Qaida Colour Coded Set',
    'SKU 03-1234-567',
  ])('does not flag %s', (text) => {
    expect(findContactInfo(text)).toEqual([]);
  });

  it('scanListingText reports the field and the matched text', () => {
    const r = scanListingText({ name: 'Maths workbook', description: 'Order on 0300 1234567 or ali@mail.com' });
    expect(r.flagged).toBe(true);
    expect(r.matches.join('|')).toContain('description: 0300 1234567');
    expect(r.matches.join('|')).toContain('ali@mail.com');
    expect(scanListingText({ name: 'Clean title here' }).flagged).toBe(false);
  });
});
