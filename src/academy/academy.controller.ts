/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AcademyService } from './academy.service';

interface AuthedReq { user: { userId: string }; ip?: string; headers: Record<string, string | string[] | undefined> }

@ApiTags('Edudeen Academy (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/academy')
export class AdminAcademyController {
  constructor(private readonly academy: AcademyService) {}

  private meta(req: AuthedReq) {
    const ua = req.headers['user-agent'];
    return { adminId: req.user.userId, ip: req.ip, userAgent: Array.isArray(ua) ? ua[0] : ua };
  }

  @Get()
  list(@Query() query: { status?: string; search?: string }) {
    return this.academy.adminList(query);
  }

  @Get(':id')
  get(@Param('id', ParseObjectIdPipe) id: string) {
    return this.academy.adminGet(id);
  }

  @Post()
  create(@Req() req: AuthedReq, @Body() body: Record<string, unknown>) {
    return this.academy.create(body ?? {}, this.meta(req));
  }

  @Put(':id')
  update(@Req() req: AuthedReq, @Param('id', ParseObjectIdPipe) id: string, @Body() body: Record<string, unknown>) {
    return this.academy.update(id, body ?? {}, this.meta(req));
  }

  @Patch(':id/status')
  setStatus(@Req() req: AuthedReq, @Param('id', ParseObjectIdPipe) id: string, @Body() body: { status?: string }) {
    return this.academy.setStatus(id, body?.status, this.meta(req));
  }

  @Delete(':id')
  remove(@Req() req: AuthedReq, @Param('id', ParseObjectIdPipe) id: string) {
    return this.academy.remove(id, this.meta(req));
  }
}

@ApiTags('Edudeen Academy')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/academy')
export class SellerAcademyController {
  constructor(private readonly academy: AcademyService) {}

  @Get('courses')
  list(@Req() req: AuthedReq, @Query() query: { sort?: string; category?: string; search?: string }) {
    return this.academy.sellerList(req.user.userId, query);
  }

  @Get('courses/:slug')
  get(@Req() req: AuthedReq, @Param('slug') slug: string) {
    return this.academy.sellerGet(req.user.userId, slug);
  }

  @Post('courses/:courseId/lessons/:lessonId/complete')
  complete(@Req() req: AuthedReq, @Param('courseId') courseId: string, @Param('lessonId') lessonId: string) {
    return this.academy.completeLesson(req.user.userId, courseId, lessonId);
  }
}
