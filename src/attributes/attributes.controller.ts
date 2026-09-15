import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AttributesService } from './attributes.service';
import { CreateAttributeDefinitionDto } from './dto/create-attribute-definition.dto';
import { UpdateAttributeDefinitionDto } from './dto/update-attribute-definition.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

// Public read + admin-managed attribute definitions, scoped per category.
// Kept alongside `api/categories` (not inside the categories module itself)
// so the existing categories controller/service stay untouched.
@Controller('api/categories')
export class CategoryAttributesController {
  constructor(private readonly attributesService: AttributesService) {}

  @Get(':categoryId/attributes')
  async listByCategory(@Param('categoryId') categoryId: string) {
    return this.attributesService.listByCategory(categoryId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post(':categoryId/attributes')
  async createDefinition(
    @Param('categoryId') categoryId: string,
    @Body() dto: CreateAttributeDefinitionDto,
  ) {
    return this.attributesService.createDefinition(categoryId, dto);
  }
}

@Controller('api/attributes')
export class AttributesController {
  constructor(private readonly attributesService: AttributesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id')
  async updateDefinition(
    @Param('id') id: string,
    @Body() dto: UpdateAttributeDefinitionDto,
  ) {
    return this.attributesService.updateDefinition(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete(':id')
  async deleteDefinition(@Param('id') id: string) {
    return this.attributesService.deleteDefinition(id);
  }
}
