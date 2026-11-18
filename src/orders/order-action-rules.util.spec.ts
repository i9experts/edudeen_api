import { cancelBlockReason, refundBlockReason } from './order-action-rules.util';

describe('cancelBlockReason', () => {
  it('blocks a buyer cancelling an availed free order', () => {
    expect(cancelBlockReason({ isFreeClaim: true, orderStatus: 'pending' }, [{ type: 'digital' }])).toMatch(/free item/);
  });
  it('blocks delivered orders', () => {
    expect(cancelBlockReason({ orderStatus: 'delivered' }, [{ type: 'physical' }])).toMatch(/Delivered/);
  });
  it('blocks digital items already downloaded', () => {
    expect(cancelBlockReason({ orderStatus: 'pending' }, [{ name: 'Maths', type: 'digital', downloadCount: 1 }])).toMatch(/Maths/);
  });
  it('allows a pending physical order', () => {
    expect(cancelBlockReason({ orderStatus: 'pending' }, [{ type: 'physical' }])).toBeNull();
  });
  it('does not apply the availed rule to staff actors', () => {
    expect(cancelBlockReason({ isFreeClaim: true, orderStatus: 'pending' }, [{ type: 'physical' }], 'admin')).toBeNull();
  });
});

describe('refundBlockReason', () => {
  it('rejects Rs 0 orders', () => {
    expect(refundBlockReason({ totalAmount: 0 }, [{ totalPrice: 0 }])).toMatch(/nothing to refund/);
    expect(refundBlockReason({ isFreeClaim: true, totalAmount: 0 }, [])).not.toBeNull();
  });
  it('allows a paid order', () => {
    expect(refundBlockReason({ totalAmount: 500 }, [{ totalPrice: 500 }])).toBeNull();
  });
});
