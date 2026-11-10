/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ProductQuestionsService } from './product-questions.service';
import { BundlesService } from './bundles.service';
import { CuratedCollectionsService } from './curated-collections.service';
import { CoursesService } from './courses.service';

/** Pre-purchase questions and seller answers on a listing. */
@Controller('api/product-questions')
export class ProductQuestionsController {
  constructor(private readonly questions: ProductQuestionsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('product/:idOrSlug')
  list(@Req() req: any, @Param('idOrSlug') idOrSlug: string) {
    return this.questions.listForProduct(idOrSlug, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard)
  @Post('product/:idOrSlug')
  ask(@Req() req: any, @Param('idOrSlug') idOrSlug: string, @Body() body: any) {
    return this.questions.ask(req.user.userId, idOrSlug, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/:storeId')
  forSeller(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string) {
    return this.questions.listForSeller(storeId, req.user.userId, status);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('seller/:storeId/:id/answer')
  answer(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() body: any) {
    return this.questions.answer(storeId, req.user.userId, id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('seller/:storeId/:id/visibility')
  visibility(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body('hidden') hidden: boolean) {
    return this.questions.setHidden(storeId, req.user.userId, id, hidden === true);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.questions.deleteOwn(req.user.userId, id);
  }
}

/** "Buy together and save" bundles. */
@Controller('api/bundles')
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('for-product/:productId')
  forProduct(@Req() req: any, @Param('productId') productId: string) {
    return this.bundles.forProduct(productId, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('public/:slug')
  bySlug(@Req() req: any, @Param('slug') slug: string) {
    return this.bundles.bySlug(slug, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('public')
  listPublic(@Req() req: any, @Query('limit') limit?: string) {
    return this.bundles.listPublic(Number(limit) || 6, req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('store/:storeId')
  forStore(@Req() req: any, @Param('storeId') storeId: string) {
    return this.bundles.forStore(storeId, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('seller/:storeId/quote')
  quote(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.bundles.quote(storeId, req.user.userId, body?.productIds, body?.discountPercent);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('seller/:storeId/suggestions')
  suggestions(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.bundles.suggestions(storeId, req.user.userId, body?.productIds);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('seller/:storeId/:id/duplicate')
  duplicate(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.bundles.duplicate(storeId, req.user.userId, id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/:storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.bundles.listForSeller(storeId, req.user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('seller/:storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.bundles.create(storeId, req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('seller/:storeId/:id')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() body: any) {
    return this.bundles.update(storeId, req.user.userId, id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('seller/:storeId/:id')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.bundles.remove(storeId, req.user.userId, id);
  }
}

/** Edudeen's own curated shelves ("Exam ki tayyari") — public reads. */
@Controller('api/curated-collections')
export class CuratedCollectionsController {
  constructor(private readonly collections: CuratedCollectionsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('home')
  home(@Req() req: any) {
    return this.collections.homeShelves(req.user?.userId ?? null);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':slug')
  bySlug(@Req() req: any, @Param('slug') slug: string) {
    return this.collections.bySlug(slug, req.user?.userId ?? null);
  }
}

/** Admin management of curated shelves. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/curated-collections')
export class AdminCuratedCollectionsController {
  constructor(private readonly collections: CuratedCollectionsService) {}

  @Get()
  list() {
    return this.collections.adminList();
  }

  @Get('product-search')
  search(@Query('q') q: string) {
    return this.collections.adminSearchProducts(q);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.collections.adminGet(id);
  }

  @Post()
  create(@Body() body: any) {
    return this.collections.adminCreate(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.collections.adminUpdate(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.collections.adminDelete(id);
  }
}

/** Online courses (builder, player, quizzes, certificates). */
@Controller('api/courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get('outline/:idOrSlug')
  outline(@Param('idOrSlug') idOrSlug: string) {
    return this.courses.outline(idOrSlug);
  }

  @Get('preview/:idOrSlug/:lessonId')
  preview(@Param('idOrSlug') idOrSlug: string, @Param('lessonId') lessonId: string) {
    return this.courses.previewLesson(idOrSlug, lessonId);
  }

  @Get('certificates/:code')
  certificate(@Param('code') code: string) {
    return this.courses.verifyCertificate(code);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@Req() req: any) {
    return this.courses.myCourses(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('learn/:idOrSlug')
  learn(@Req() req: any, @Param('idOrSlug') idOrSlug: string) {
    return this.courses.getLearnView(req.user.userId, idOrSlug);
  }

  @UseGuards(JwtAuthGuard)
  @Get('learn/:idOrSlug/lessons/:lessonId')
  lesson(@Req() req: any, @Param('idOrSlug') idOrSlug: string, @Param('lessonId') lessonId: string) {
    return this.courses.getLesson(req.user.userId, idOrSlug, lessonId);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('learn/:idOrSlug/certificate-details')
  certificateDetails(@Req() req: any, @Param('idOrSlug') idOrSlug: string, @Body() body: any) {
    return this.courses.saveCertificateDetails(req.user.userId, idOrSlug, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('learn/:idOrSlug/lessons/:lessonId/complete')
  complete(@Req() req: any, @Param('idOrSlug') idOrSlug: string, @Param('lessonId') lessonId: string) {
    return this.courses.markComplete(req.user.userId, idOrSlug, lessonId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('learn/:idOrSlug/lessons/:lessonId/quiz')
  quiz(@Req() req: any, @Param('idOrSlug') idOrSlug: string, @Param('lessonId') lessonId: string, @Body('answers') answers: unknown) {
    return this.courses.submitQuiz(req.user.userId, idOrSlug, lessonId, answers);
  }

  // Store-level students & downloads. Declared BEFORE `seller/:storeId/:productId` so "roster" is never read as a product id.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/:storeId/roster')
  roster(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Query() query: any) {
    return this.courses.rosterForSeller(storeId, req.user.userId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('seller/:storeId/roster/export')
  async rosterExport(@Req() req: any, @Param('storeId', ParseObjectIdPipe) storeId: string, @Query() query: any, @Res() res: Response) {
    const csv = await this.courses.rosterForSeller(storeId, req.user.userId, query, true);
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="students.csv"');
    res.header('Cache-Control', 'no-store');
    res.send(csv);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/:storeId/:productId')
  getBuilder(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string) {
    return this.courses.getForSeller(storeId, req.user.userId, productId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/:storeId/:productId/students')
  students(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.courses.studentsForSeller(storeId, req.user.userId, productId, { page, limit });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Put('seller/:storeId/:productId')
  saveBuilder(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string, @Body() body: any) {
    return this.courses.saveForSeller(storeId, req.user.userId, productId, body);
  }
}