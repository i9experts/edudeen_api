/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- mock-heavy tests */
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertKycTransition, decryptKycValue, encryptKycValue, isKycEditable, maskTail, missingKycRequirements, namesRoughlyMatch,
} from './kyc.util';
import { KycService, buildKycDraftUpdate } from './kyc.service';

process.env.SEO_TOKEN_ENCRYPTION_KEY ??= 'test-only-encryption-key';

const completeIndividual = () => ({
  sellerType: 'individual' as const,
  address: { country: 'Pakistan', state: 'Sindh', city: 'Karachi', line: 'D-8, Block 5' },
  idType: 'cnic' as const,
  fullName: 'Atiq Ur Rehman',
  idNumberEnc: 'enc',
  bankAccountHolder: 'Atiq Ur Rehman',
  documents: [{ type: 'id_front' as const }, { type: 'id_back' as const }, { type: 'bank_proof' as const }],
});

describe('KYC requirements', () => {
  it('an individual with every field and document is ready; tax number is optional for them', () => {
    expect(missingKycRequirements(completeIndividual())).toEqual([]);
  });

  it('lists what is missing in plain words', () => {
    const m = missingKycRequirements({});
    expect(m).toEqual(expect.arrayContaining(['Seller type', 'Country', 'ID front photo', 'ID back photo', 'ID / passport number', 'Bank statement or cheque']));
  });

  it('a passport needs no back photo', () => {
    const k = { ...completeIndividual(), idType: 'passport' as const, documents: [{ type: 'id_front' as const }, { type: 'bank_proof' as const }] };
    expect(missingKycRequirements(k)).toEqual([]);
  });

  it('a company also needs tax number, legal name, registration number and certificate', () => {
    const k = { ...completeIndividual(), sellerType: 'company' as const };
    expect(missingKycRequirements(k)).toEqual(['National tax number', 'Legal business name', 'Registration number', 'Registration certificate']);
    const done = {
      ...k, taxNumberEnc: 'enc', legalBusinessName: 'M. Publishers', registrationNumber: 'REG-1',
      documents: [...k.documents, { type: 'registration_certificate' as const }],
    };
    expect(missingKycRequirements(done)).toEqual([]);
  });
});

describe('KYC status transitions', () => {
  it('allows submit, review, resubmit and revoke', () => {
    expect(() => assertKycTransition('not_started', 'pending')).not.toThrow();
    expect(() => assertKycTransition('pending', 'approved')).not.toThrow();
    expect(() => assertKycTransition('pending', 'rejected')).not.toThrow();
    expect(() => assertKycTransition('rejected', 'pending')).not.toThrow();
    expect(() => assertKycTransition('approved', 'rejected')).not.toThrow();
  });

  it('never approves without a submission and never re-opens an approved KYC for editing', () => {
    expect(() => assertKycTransition('not_started', 'approved')).toThrow(BadRequestException);
    expect(() => assertKycTransition('rejected', 'approved')).toThrow(BadRequestException);
    expect(() => assertKycTransition('approved', 'pending')).toThrow(BadRequestException);
    expect(isKycEditable('pending')).toBe(false);
    expect(isKycEditable('approved')).toBe(false);
    expect(isKycEditable('rejected')).toBe(true);
  });
});

describe('KYC masking and encryption', () => {
  it('masks to the last 4 characters only', () => {
    expect(maskTail('4210112345671')).toBe('••••5671');
    expect(maskTail(null)).toBeNull();
  });

  it('stores ID and tax numbers encrypted, keeping only the last 4 readable', () => {
    const set = buildKycDraftUpdate({ idNumber: '42101-1234567-1', taxNumber: ' 1234567-8 ' });
    expect(set.idNumberLast4).toBe('5671');
    expect(set.taxNumberLast4).toBe('5678');
    expect(set.idNumberEnc).not.toContain('4210112345671');
    expect(decryptKycValue(set.idNumberEnc as string)).toBe('4210112345671');
    expect(decryptKycValue(encryptKycValue('AB123'))).toBe('AB123');
  });

  it('rejects bad enum values and odd characters', () => {
    expect(() => buildKycDraftUpdate({ sellerType: 'robot' })).toThrow(BadRequestException);
    expect(() => buildKycDraftUpdate({ idType: 'library_card' })).toThrow(BadRequestException);
    expect(() => buildKycDraftUpdate({ idNumber: '12<script>' })).toThrow(BadRequestException);
  });

  it('name match is loose: case, dots and extra words are fine; a different person is not', () => {
    expect(namesRoughlyMatch('Atiq Ur Rehman', 'ATIQ UR REHMAN')).toBe(true);
    expect(namesRoughlyMatch('Atiq Ur Rehman', 'Mr. Atiq Ur Rehman')).toBe(true);
    expect(namesRoughlyMatch('Atiq Ur Rehman', 'Bilal Khan')).toBe(false);
  });
});

describe('KycService', () => {
  const SELLER = '64b000000000000000000001';
  const KYC_ID = '64b0000000000000000000aa';
  let kycModel: any;
  let sellerModel: any;
  let storeModel: any;
  let notify: jest.Mock;
  let log: jest.Mock;
  let service: KycService;

  const lean = (v: any) => ({ lean: jest.fn().mockResolvedValue(v), select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }) });

  beforeEach(() => {
    kycModel = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      findById: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    sellerModel = { updateOne: jest.fn().mockResolvedValue({}) };
    storeModel = { updateMany: jest.fn().mockResolvedValue({}) };
    notify = jest.fn().mockResolvedValue(undefined);
    log = jest.fn().mockResolvedValue(true);
    const db: any = { repositories: { sellerModel, storeModel } };
    const upload: any = { generateSignedUrl: jest.fn().mockReturnValue('https://signed'), uploadPrivateFile: jest.fn() };
    service = new KycService(kycModel, db, upload, { log } as any, { notify } as any);
  });

  it('submit refuses an incomplete KYC and says what is missing', async () => {
    kycModel.findOneAndUpdate.mockResolvedValueOnce({ _id: KYC_ID, status: 'not_started' });
    kycModel.findById.mockReturnValue(lean({ sellerType: 'individual' }));
    await expect(service.submit(SELLER)).rejects.toThrow(/Please complete: .*Country/);
    expect(sellerModel.updateOne).not.toHaveBeenCalled();
  });

  it('submit moves a complete KYC to pending, flags a bank-name mismatch and mirrors the status on the seller', async () => {
    kycModel.findOneAndUpdate
      .mockResolvedValueOnce({ _id: KYC_ID, status: 'not_started' })
      .mockReturnValueOnce(lean({ status: 'pending' }));
    kycModel.findById.mockReturnValue(lean({ ...completeIndividual(), bankAccountHolder: 'Someone Else' }));
    const view = await service.submit(SELLER);
    expect(view.status).toBe('pending');
    const update = kycModel.findOneAndUpdate.mock.calls[1][1];
    expect(update.$set).toEqual(expect.objectContaining({ status: 'pending', nameMismatchFlagged: true }));
    expect(sellerModel.updateOne).toHaveBeenCalledWith({ _id: SELLER }, { $set: { kycStatus: 'pending' } });
  });

  it('a pending or approved KYC cannot be edited by the seller', async () => {
    kycModel.findOneAndUpdate.mockResolvedValue({ _id: KYC_ID, status: 'approved' });
    await expect(service.saveDraft(SELLER, { fullName: 'X' })).rejects.toThrow(ConflictException);
    kycModel.findOneAndUpdate.mockResolvedValue({ _id: KYC_ID, status: 'pending' });
    await expect(service.submit(SELLER)).rejects.toThrow(ConflictException);
  });

  it('seller view never exposes the encrypted numbers or storage ids', async () => {
    kycModel.findOne.mockReturnValue(lean({
      status: 'rejected', rejectionReason: 'Blurry photo', idNumberLast4: '5671', idNumberEnc: 'SECRET',
      documents: [{ type: 'id_front', publicId: 'r2/private/kyc/abc', resourceType: 'image', fileName: 'front.jpg' }],
    }));
    const view: any = await service.getMine(SELLER);
    expect(view.idNumberMasked).toBe('••••5671');
    expect(JSON.stringify(view)).not.toContain('SECRET');
    expect(JSON.stringify(view)).not.toContain('r2/private');
    expect(view.documents[0].viewUrl).toBe('https://signed');
    expect(view.rejectionReason).toBe('Blurry photo');
    expect(view.editable).toBe(true);
  });

  it('approve sets the seller mirror, adds the Verified badge to their stores, logs and notifies', async () => {
    kycModel.findById.mockReturnValue(lean({ _id: KYC_ID, sellerId: SELLER, status: 'pending', fullName: 'Atiq' }));
    kycModel.findOneAndUpdate.mockReturnValue(lean({ _id: KYC_ID, status: 'approved' }));
    await service.adminDecide(KYC_ID, 'approve', undefined, { adminId: 'admin-1' });
    expect(sellerModel.updateOne).toHaveBeenCalledWith({ _id: SELLER }, { $set: { kycStatus: 'approved' } });
    expect(storeModel.updateMany).toHaveBeenCalledWith({ sellerId: SELLER }, { $addToSet: { badges: 'verified' } });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'seller_kyc_approved' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'kyc_approved', recipientId: SELLER }));
  });

  it('reject needs a reason; revoke removes the badge; a decided KYC cannot be decided twice', async () => {
    await expect(service.adminDecide(KYC_ID, 'reject', '  ', { adminId: 'a' })).rejects.toThrow(/why/);

    kycModel.findById.mockReturnValue(lean({ _id: KYC_ID, sellerId: SELLER, status: 'approved' }));
    kycModel.findOneAndUpdate.mockReturnValue(lean({ _id: KYC_ID, status: 'rejected' }));
    await service.adminDecide(KYC_ID, 'revoke', 'Fake ID', { adminId: 'a' });
    expect(storeModel.updateMany).toHaveBeenCalledWith({ sellerId: SELLER }, { $pull: { badges: 'verified' } });
    expect(sellerModel.updateOne).toHaveBeenCalledWith({ _id: SELLER }, { $set: { kycStatus: 'rejected' } });

    await expect(service.adminDecide(KYC_ID, 'approve', undefined, { adminId: 'a' })).rejects.toThrow(ConflictException);
  });
});
