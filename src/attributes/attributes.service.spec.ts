/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AttributesService } from './attributes.service';
import { DatabaseService } from '../database/databaseservice';
import { AttributeValueType } from './schemas/attribute-definition.schema';

describe('AttributesService', () => {
  let service: AttributesService;
  let attributeDefinitionModel: any;
  let productAttributeValueModel: any;
  let productModel: any;
  let categoryModel: any;

  const VALID_CATEGORY_ID = '507f1f77bcf86cd799439011';
  const VALID_PRODUCT_ID = '507f1f77bcf86cd799439012';

  beforeEach(() => {
    attributeDefinitionModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      create: jest.fn(),
    };
    productAttributeValueModel = {
      find: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({}),
      insertMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
    };
    productModel = { findOne: jest.fn() };
    categoryModel = { findOne: jest.fn() };

    const db = {
      repositories: {
        attributeDefinitionModel,
        productAttributeValueModel,
        productModel,
        categoryModel,
      },
    } as unknown as DatabaseService;

    service = new AttributesService(db);
  });

  describe('createDefinition', () => {
    it('rejects a select attribute with no options', async () => {
      categoryModel.findOne.mockResolvedValue({ _id: VALID_CATEGORY_ID });
      attributeDefinitionModel.findOne.mockResolvedValue(null);

      await expect(
        service.createDefinition(VALID_CATEGORY_ID, {
          key: 'subject',
          label: 'Subject',
          type: AttributeValueType.SELECT,
          options: [],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a duplicate key within the same category', async () => {
      categoryModel.findOne.mockResolvedValue({ _id: VALID_CATEGORY_ID });
      attributeDefinitionModel.findOne.mockResolvedValue({ _id: 'existing' });

      await expect(
        service.createDefinition(VALID_CATEGORY_ID, {
          key: 'subject',
          label: 'Subject',
          type: AttributeValueType.SELECT,
          options: ['Math'],
        } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('creates a definition when validation passes', async () => {
      categoryModel.findOne.mockResolvedValue({ _id: VALID_CATEGORY_ID });
      attributeDefinitionModel.findOne.mockResolvedValue(null);
      attributeDefinitionModel.create.mockResolvedValue({ _id: 'new-id', key: 'subject' });

      const result = await service.createDefinition(VALID_CATEGORY_ID, {
        key: 'subject',
        label: 'Subject',
        type: AttributeValueType.SELECT,
        options: ['Math', 'Science'],
      } as any);

      expect(attributeDefinitionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId: VALID_CATEGORY_ID, key: 'subject' }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('setProductAttributes', () => {
    const definitions = [
      {
        _id: { toString: () => 'def-subject' },
        key: 'subject',
        label: 'Subject',
        type: AttributeValueType.SELECT,
        options: ['Math', 'Science'],
        required: true,
      },
      {
        _id: { toString: () => 'def-format' },
        key: 'format',
        label: 'Format',
        type: AttributeValueType.MULTISELECT,
        options: ['PDF', 'Slides'],
        required: false,
      },
    ];

    beforeEach(() => {
      attributeDefinitionModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(definitions) });
    });

    it('rejects when the caller does not own the product', async () => {
      productModel.findOne.mockResolvedValue({
        sellerId: 'seller-owner',
        categoryId: VALID_CATEGORY_ID,
        subCategoryId: null,
        isDelete: false,
      });

      await expect(
        service.setProductAttributes('someone-else', VALID_PRODUCT_ID, {
          attributes: [{ attributeDefinitionId: 'def-subject', values: ['Math'] }],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when a required attribute is missing', async () => {
      productModel.findOne.mockResolvedValue({
        sellerId: 'seller-owner',
        categoryId: VALID_CATEGORY_ID,
        subCategoryId: null,
        isDelete: false,
      });

      await expect(
        service.setProductAttributes('seller-owner', VALID_PRODUCT_ID, {
          attributes: [{ attributeDefinitionId: 'def-format', values: ['PDF'] }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a value outside the defined options', async () => {
      productModel.findOne.mockResolvedValue({
        sellerId: 'seller-owner',
        categoryId: VALID_CATEGORY_ID,
        subCategoryId: null,
        isDelete: false,
      });

      await expect(
        service.setProductAttributes('seller-owner', VALID_PRODUCT_ID, {
          attributes: [{ attributeDefinitionId: 'def-subject', values: ['History'] }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('saves valid attribute values, replacing any existing set', async () => {
      productModel.findOne.mockResolvedValue({
        sellerId: 'seller-owner',
        categoryId: VALID_CATEGORY_ID,
        subCategoryId: null,
        isDelete: false,
      });

      const result = await service.setProductAttributes('seller-owner', VALID_PRODUCT_ID, {
        attributes: [
          { attributeDefinitionId: 'def-subject', values: ['Math'] },
          { attributeDefinitionId: 'def-format', values: ['PDF', 'Slides'] },
        ],
      });

      expect(productAttributeValueModel.deleteMany).toHaveBeenCalledWith({ productId: VALID_PRODUCT_ID });
      expect(productAttributeValueModel.insertMany).toHaveBeenCalledWith([
        { productId: VALID_PRODUCT_ID, attributeDefinitionId: 'def-subject', key: 'subject', values: ['Math'] },
        { productId: VALID_PRODUCT_ID, attributeDefinitionId: 'def-format', key: 'format', values: ['PDF', 'Slides'] },
      ]);
      expect(result.success).toBe(true);
    });
  });

  describe('filterProductIdsByAttributes', () => {
    it('returns null when no filter keys are provided', async () => {
      const result = await service.filterProductIdsByAttributes({});
      expect(result).toBeNull();
      expect(productAttributeValueModel.aggregate).not.toHaveBeenCalled();
    });

    it('requires every filtered key to match (AND across keys)', async () => {
      productAttributeValueModel.aggregate.mockReturnValue({
        exec: jest.fn().mockResolvedValue([{ _id: 'prod-1' }]),
      });

      const result = await service.filterProductIdsByAttributes({
        subject: ['Math'],
        format: ['PDF'],
      });

      expect(result).toEqual(['prod-1']);
      const pipeline = productAttributeValueModel.aggregate.mock.calls[0][0];
      const groupStage = pipeline.find((s: any) => s.$group);
      expect(groupStage.$group.matchedKeys).toEqual({ $addToSet: '$key' });
      const sizeMatchStage = pipeline.find((s: any) => s.$match?.matchedKeys);
      expect(sizeMatchStage.$match.matchedKeys).toEqual({ $size: 2 });
    });
  });
});
