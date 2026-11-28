/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { ManagedStoresService } from './managed-stores.service';
import { AssignStoreDto, UpdateManagedStoreDto } from './dto/managed-stores.dto';

const MOU_FILE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Managed sellers (MOU) and store assignments. Staff rights (staff/permissions.ts): `GET /mine` needs
 * `stores.operate`; everything else needs `managed.manage`. The owner admin may do everything.
 */
@ApiTags('Admin — Managed stores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/managed-stores')
export class ManagedStoresController {
  constructor(private readonly service: ManagedStoresService) {}

  private actor(req: any) {
    return { id: String(req.user.userId), ip: req.ip, userAgent: req.headers?.['user-agent'] };
  }

  @Get()
  async list(@Query() query: any) {
    return { success: true, data: await this.service.list(query ?? {}) };
  }

  @Get('mine')
  async mine(@Req() req: any) {
    return { success: true, data: await this.service.mine(String(req.user.userId)) };
  }

  @Get('team')
  async team() {
    return { success: true, data: await this.service.team() };
  }

  @Get(':storeId')
  async get(@Param('storeId', ParseObjectIdPipe) storeId: string) {
    return { success: true, data: await this.service.get(storeId) };
  }

  @Patch(':storeId')
  async update(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Body() dto: UpdateManagedStoreDto) {
    return { success: true, data: await this.service.update(this.actor(req), storeId, dto) };
  }

  @Post(':storeId/mou-document')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MOU_FILE_MAX_BYTES } }))
  async uploadDocument(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @UploadedFile() file: Express.Multer.File) {
    return { success: true, data: await this.service.uploadDocument(this.actor(req), storeId, file) };
  }

  @Get(':storeId/mou-document')
  async documentUrl(@Param('storeId', ParseObjectIdPipe) storeId: string) {
    return { success: true, data: await this.service.documentUrl(storeId) };
  }

  @Post(':storeId/assignments')
  async assign(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Body() dto: AssignStoreDto) {
    return { success: true, data: await this.service.assign(this.actor(req), storeId, dto.adminId, dto.role) };
  }

  @Delete(':storeId/assignments/:adminId')
  async unassign(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Param('adminId', ParseObjectIdPipe) adminId: string) {
    return { success: true, data: await this.service.unassign(this.actor(req), storeId, adminId) };
  }
}
