/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- private method under test */
/** App backend gap #4: a digital download needs a free sample file to go live (drafts, courses, physical exempt). */
import { BadRequestException } from '@nestjs/common';
import { FREE_SAMPLE_REQUIRED_MESSAGE, ProductsService } from './products.service';

const svc: any = Object.create(ProductsService.prototype);
const base = { title: 'Grade 5 Maths Worksheets', type: 'digital' as const, description: 'Twenty pages of practice', classFrom: 'class_5', classTo: 'class_5', coverStyle: 'book', imageCount: 1 };
const check = (o: any) => () => svc.checkListing({ ...base, ...o });

describe('free sample required to publish a digital download', () => {
  it('blocks active and scheduled without a sample', () => {
    for (const requestedStatus of ['active', 'scheduled']) {
      expect(check({ requestedStatus, deliveryFormat: 'download', hasSample: false })).toThrow(new BadRequestException(FREE_SAMPLE_REQUIRED_MESSAGE));
    }
  });
  it('allows publishing with a sample', () => {
    expect(check({ requestedStatus: 'active', deliveryFormat: 'download', hasSample: true })).not.toThrow();
  });
  it('drafts and inactive saves are exempt', () => {
    expect(check({ requestedStatus: 'draft', hasSample: false })).not.toThrow();
    expect(check({ requestedStatus: 'inactive', hasSample: false })).not.toThrow();
    expect(check({ requestedStatus: undefined, hasSample: false })).not.toThrow();
  });
  it('courses and physical products are exempt', () => {
    expect(check({ requestedStatus: 'active', deliveryFormat: 'course', hasSample: false })).not.toThrow();
    expect(check({ requestedStatus: 'active', type: 'physical', hasSample: false })).not.toThrow();
  });
  it('re-saving an already-live listing as-is is not a new publish (legacy listings keep working)', () => {
    expect(check({ requestedStatus: 'active', currentStatus: 'active', hasSample: false })).not.toThrow();
  });
  it('callers that do not pass hasSample are unaffected', () => {
    expect(check({ requestedStatus: 'active' })).not.toThrow();
  });
});
