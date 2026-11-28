import mongoose from 'mongoose';
import { MessageSchema } from '../messaging/schemas/message.schema';
import { ProductSchema } from '../products/schemas/product.schema';

describe('acting-staff fields stay internal', () => {
  it('are select:false and stripped from toJSON/toObject', () => {
    expect((MessageSchema.path('actingStaffId') as any).options.select).toBe(
      false,
    );
    for (const f of [
      'createdByStaffId',
      'lastEditedByStaffId',
      'lastEditedByStaffAt',
    ])
      expect((ProductSchema.path(f) as any).options.select).toBe(false);
    const M = mongoose.model('HiddenStaffMsgTest', MessageSchema);
    const m = new M({
      conversationId: 'c',
      senderId: 's',
      senderRole: 'seller',
      type: 'text',
      actingStaffId: 'staff1',
    });
    expect(m.toJSON()).not.toHaveProperty('actingStaffId');
    expect(m.toObject()).not.toHaveProperty('actingStaffId');
    expect(m.get('actingStaffId')).toBe('staff1');
  });
});
