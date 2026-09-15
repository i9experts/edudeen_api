import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from 'src/database/databaseservice';
import { CreateAttributeDefinitionDto } from './dto/create-attribute-definition.dto';
import { UpdateAttributeDefinitionDto } from './dto/update-attribute-definition.dto';
import { SetProductAttributesDto } from './dto/set-product-attributes.dto';
import { AttributeValueType } from './schemas/attribute-definition.schema';

@Injectable()
export class AttributesService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listByCategory(categoryId: string) {
    if (!isValidObjectId(categoryId)) {
      throw new BadRequestException('Invalid category id');
    }
    const definitions = await this.databaseService.repositories.attributeDefinitionModel
      .find({ categoryId, isDelete: false })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    return {
      success: true,
      message: 'Attribute definitions fetched successfully',
      data: definitions,
    };
  }

  async createDefinition(
    categoryId: string,
    dto: CreateAttributeDefinitionDto,
  ) {
    if (!isValidObjectId(categoryId)) {
      throw new BadRequestException('Invalid category id');
    }
    const categoryModel = this.databaseService.repositories.categoryModel;
    const category = await categoryModel.findOne({
      _id: categoryId,
      status: 'active',
      isDelete: false,
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }

    const type = dto.type ?? AttributeValueType.SELECT;
    if (
      (type === AttributeValueType.SELECT ||
        type === AttributeValueType.MULTISELECT) &&
      (!dto.options || dto.options.length === 0)
    ) {
      throw new BadRequestException(
        'select/multiselect attributes need at least one option',
      );
    }

    const model = this.databaseService.repositories.attributeDefinitionModel;
    const existing = await model.findOne({ categoryId, key: dto.key, isDelete: false });
    if (existing) {
      throw new ConflictException(
        `An attribute with key "${dto.key}" already exists for this category`,
      );
    }

    const created = await model.create({
      categoryId,
      key: dto.key,
      label: dto.label,
      type,
      options: dto.options ?? [],
      required: dto.required ?? false,
      searchable: dto.searchable ?? true,
      sortOrder: dto.sortOrder ?? 0,
    });

    return {
      success: true,
      message: 'Attribute definition created successfully',
      data: created,
    };
  }

  async updateDefinition(id: string, dto: UpdateAttributeDefinitionDto) {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid attribute id');
    }
    const model = this.databaseService.repositories.attributeDefinitionModel;
    const definition = await model.findOne({ _id: id, isDelete: false });
    if (!definition) {
      throw new NotFoundException('Attribute definition not found');
    }

    const nextType = dto.type ?? definition.type;
    const nextOptions = dto.options ?? definition.options;
    if (
      (nextType === AttributeValueType.SELECT ||
        nextType === AttributeValueType.MULTISELECT) &&
      (!nextOptions || nextOptions.length === 0)
    ) {
      throw new BadRequestException(
        'select/multiselect attributes need at least one option',
      );
    }

    Object.assign(definition, dto);
    await definition.save();

    return {
      success: true,
      message: 'Attribute definition updated successfully',
      data: definition,
    };
  }

  async deleteDefinition(id: string) {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid attribute id');
    }
    const model = this.databaseService.repositories.attributeDefinitionModel;
    const definition = await model.findOneAndUpdate(
      { _id: id, isDelete: false },
      { isDelete: true },
      { new: true },
    );
    if (!definition) {
      throw new NotFoundException('Attribute definition not found');
    }

    return {
      success: true,
      message: 'Attribute definition removed successfully',
      data: definition,
    };
  }

  async getProductAttributes(productId: string) {
    if (!isValidObjectId(productId)) {
      throw new BadRequestException('Invalid product id');
    }
    const valueModel = this.databaseService.repositories.productAttributeValueModel;
    const values = await valueModel.find({ productId }).lean();

    const definitionModel = this.databaseService.repositories.attributeDefinitionModel;
    const definitionIds = values.map((v) => v.attributeDefinitionId);
    const definitions = await definitionModel
      .find({ _id: { $in: definitionIds } })
      .lean();
    const definitionMap = new Map(
      definitions.map((d) => [d._id.toString(), d]),
    );

    const data = values.map((v) => {
      const def = definitionMap.get(v.attributeDefinitionId);
      return {
        attributeDefinitionId: v.attributeDefinitionId,
        key: v.key,
        label: def?.label ?? v.key,
        type: def?.type ?? AttributeValueType.TEXT,
        values: v.values,
      };
    });

    return {
      success: true,
      message: 'Product attributes fetched successfully',
      data,
    };
  }

  async setProductAttributes(
    sellerId: string,
    productId: string,
    dto: SetProductAttributesDto,
  ) {
    if (!isValidObjectId(productId)) {
      throw new BadRequestException('Invalid product id');
    }
    const productModel = this.databaseService.repositories.productModel;
    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    if (product.sellerId !== sellerId) {
      throw new ForbiddenException('You do not own this product');
    }

    // A product is classified against whichever category it was actually
    // placed under — the subcategory when one was chosen, else the main
    // category — matching how CategoriesService/ProductsService already
    // resolve "the product's category" everywhere else.
    const effectiveCategoryId = product.subCategoryId || product.categoryId;

    const definitionModel = this.databaseService.repositories.attributeDefinitionModel;
    const definitions = await definitionModel
      .find({ categoryId: effectiveCategoryId, isDelete: false })
      .lean();
    const definitionMap = new Map(
      definitions.map((d) => [d._id.toString(), d]),
    );

    const providedIds = new Set(
      dto.attributes.map((a) => a.attributeDefinitionId),
    );

    // Every required attribute for this category must be present.
    const missingRequired = definitions.filter(
      (d) => d.required && !providedIds.has(d._id.toString()),
    );
    if (missingRequired.length) {
      throw new BadRequestException(
        `Missing required attribute(s): ${missingRequired.map((d) => d.label).join(', ')}`,
      );
    }

    const rows: {
      productId: string;
      attributeDefinitionId: string;
      key: string;
      values: string[];
    }[] = [];

    for (const entry of dto.attributes) {
      const definition = definitionMap.get(entry.attributeDefinitionId);
      if (!definition) {
        throw new BadRequestException(
          `Attribute ${entry.attributeDefinitionId} does not belong to this product's category`,
        );
      }
      if (
        definition.type === AttributeValueType.SELECT &&
        entry.values.length > 1
      ) {
        throw new BadRequestException(
          `${definition.label} only accepts a single value`,
        );
      }
      if (
        (definition.type === AttributeValueType.SELECT ||
          definition.type === AttributeValueType.MULTISELECT) &&
        entry.values.some((v) => !definition.options.includes(v))
      ) {
        throw new BadRequestException(
          `${definition.label} only accepts: ${definition.options.join(', ')}`,
        );
      }
      if (entry.values.length === 0) {
        continue; // clearing a value — simply omit it below
      }
      rows.push({
        productId,
        attributeDefinitionId: entry.attributeDefinitionId,
        key: definition.key,
        values: entry.values,
      });
    }

    const valueModel = this.databaseService.repositories.productAttributeValueModel;
    // Replace-all is simpler and safe here — attribute sets are small
    // (a handful of definitions per category) and this is a low-frequency
    // write (product create/edit), not a hot path.
    await valueModel.deleteMany({ productId });
    if (rows.length) {
      await valueModel.insertMany(rows);
    }

    return {
      success: true,
      message: 'Product attributes saved successfully',
      data: rows,
    };
  }

  /** Returns the set of productIds whose attribute values match every
   *  requested key (AND across keys, OR within a key's selected values).
   *  Returns null when no attribute filter was requested at all — callers
   *  should treat that as "don't restrict by attributes", not "match none". */
  async filterProductIdsByAttributes(
    filter: Record<string, string[]>,
  ): Promise<string[] | null> {
    const keys = Object.keys(filter).filter((k) => filter[k]?.length);
    if (!keys.length) return null;

    const valueModel = this.databaseService.repositories.productAttributeValueModel;
    const rows = await valueModel
      .aggregate([
        {
          $match: {
            $or: keys.map((key) => ({ key, values: { $in: filter[key] } })),
          },
        },
        { $group: { _id: '$productId', matchedKeys: { $addToSet: '$key' } } },
        { $match: { matchedKeys: { $size: keys.length } } },
        { $project: { _id: 1 } },
      ])
      .exec();

    return rows.map((r: { _id: string }) => r._id);
  }
}
