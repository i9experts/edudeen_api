/* eslint-disable prettier/prettier */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Body,
  Param,
  Req,
  Query,
} from '@nestjs/common';

import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';

interface AdminRequest {
  user: { userId: string };
  ip?: string;
  headers: Record<string, string | undefined>;
}
const auditMeta = (req: AdminRequest) => (auditMeta(req));

@Controller('api/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post('add-category')
  async addCategory(
    @Req() req: any,
    @Body() createCategoryDto: CreateCategoryDto,
  ) {
    const { userId, role } = req.user;
    return this.categoriesService.addCategory(userId, role, createCategoryDto);
  }

  @Get('category-tree')
  async getCategoryTree(@Query('id') id?: string) {
    return this.categoriesService.getCategoryTreeNested(id);
  }

  @Get('category/:id')
  async getCategoryById(@Param('id') id: string) {
    return this.categoriesService.getCategoryWithChildren(id);
  }

  // ── Admin taxonomy management (declared reorder before :id routes) ──
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('reorder')
  async reorder(@Req() req: AdminRequest, @Body() dto: ReorderCategoriesDto) {
    return this.categoriesService.reorderCategories(dto, auditMeta(req));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('category/:id')
  async update(@Req() req: AdminRequest, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.updateCategory(id, dto, auditMeta(req));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('category/:id')
  async remove(@Req() req: AdminRequest, @Param('id') id: string, @Query('reassignTo') reassignTo?: string) {
    return this.categoriesService.deleteCategory(id, reassignTo, auditMeta(req));
  }
}
