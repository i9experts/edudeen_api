/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { LearningPathsService } from './learning-paths.service';

/** Public learning paths + "save as my reading list". */
@Controller('api/learning-paths')
export class LearningPathsController {
  constructor(private readonly paths: LearningPathsService) {}

  @Get()
  list(@Query('level') level?: string) {
    return this.paths.list(level);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':slug')
  bySlug(@Req() req: any, @Param('slug') slug: string) {
    return this.paths.bySlug(slug, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post(':slug/save-to-list')
  save(@Req() req: any, @Param('slug') slug: string) {
    return this.paths.saveToList(req.user.userId, slug);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/learning-paths')
export class AdminLearningPathsController {
  constructor(private readonly paths: LearningPathsService) {}

  @Get() list() { return this.paths.adminList(); }
  @Get(':id') one(@Param('id') id: string) { return this.paths.adminGet(id); }
  @Post() create(@Body() body: any) { return this.paths.adminCreate(body); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: any) { return this.paths.adminUpdate(id, body); }
  @Delete(':id') remove(@Param('id') id: string) { return this.paths.adminDelete(id); }
}
