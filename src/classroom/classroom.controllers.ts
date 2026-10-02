/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SavedListsService } from './saved-lists.service';
import { ProductQuestionsService } from './product-questions.service';
import { QuoteRequestsService } from './quote-requests.service';
import { BundlesService } from './bundles.service';
import { CuratedCollectionsService } from './curated-collections.service';
import { CoursesService } from './courses.service';

/** Teacher lists — many named, shareable lists per buyer. */
@Controller('api/lists')
export class SavedListsController {
  constructor(private readonly lists: SavedListsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get('public/:slug')
  bySlug(@Req() req: any, @Param('slug') slug: string) {
    return this.lists.getBySlug(slug, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@Req() req: any) {
    return this.lists.getMine(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.lists.create(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    return this.lists.update(req.user.userId, id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.lists.remove(req.user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/items')
  addItem(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    return this.lists.addItem(req.user.userId, id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/items/:productId')
  note(@Req() req: any, @Param('id') id: string, @Param('productId') productId: string, @Body() body: any) {
    return this.lists.updateItemNote(req.user.userId, id, productId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/items/:productId')
  removeItem(@Req() req: any, @Param('id') id: string, @Param('productId') productId: string) {
    return this.lists.removeItem(req.user.userId, id, productId);
  }
}

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

/** Bulk / school quote requests. */
@Controller('api/quotes')
export class QuoteRequestsController {
  constructor(private readonly quotes: QuoteRequestsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Req() req: any, @Body() body: any) {
    return this.quotes.create(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@Req() req: any) {
    return this.quotes.listMine(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('mine/:id/:action')
  respond(@Req() req: any, @Param('id') id: string, @Param('action') action: string) {
    if (!['accept', 'decline', 'cancel'].includes(action)) return { success: false, message: 'Unknown action' };
    return this.quotes.respondAsBuyer(req.user.userId, id, action as 'accept' | 'decline' | 'cancel');
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/:storeId')
  forSeller(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string) {
    return this.quotes.listForSeller(storeId, req.user.userId, status);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('seller/:storeId/:id/offer')
  offer(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() body: any) {
    return this.quotes.sendOffer(storeId, req.user.userId, id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('seller/:storeId/:id/decline')
  decline(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() body: any) {
    return this.quotes.declineAsSeller(storeId, req.user.userId, id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  one(@Req() req: any, @Param('id') id: string) {
    return this.quotes.getOne(req.user.userId, id);
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

/** Online courses (builder, player, quizzes, certificates) and live-class access. */
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

  @Get('live-seats/:idOrSlug')
  seats(@Param('idOrSlug') idOrSlug: string) {
    return this.courses.seats(idOrSlug);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@Req() req: any) {
    return this.courses.myCourses(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('live/:idOrSlug')
  live(@Req() req: any, @Param('idOrSlug') idOrSlug: string) {
    return this.courses.liveAccess(req.user.userId, idOrSlug);
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
  @Post('learn/:idOrSlug/lessons/:lessonId/complete')
  complete(@Req() req: any, @Param('idOrSlug') idOrSlug: string, @Param('lessonId') lessonId: string) {
    return this.courses.markComplete(req.user.userId, idOrSlug, lessonId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('learn/:idOrSlug/lessons/:lessonId/quiz')
  quiz(@Req() req: any, @Param('idOrSlug') idOrSlug: string, @Param('lessonId') lessonId: string, @Body('answers') answers: unknown) {
    return this.courses.submitQuiz(req.user.userId, idOrSlug, lessonId, answers);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/:storeId/:productId')
  getBuilder(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string) {
    return this.courses.getForSeller(storeId, req.user.userId, productId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Put('seller/:storeId/:productId')
  saveBuilder(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string, @Body() body: any) {
    return this.courses.saveForSeller(storeId, req.user.userId, productId, body);
  }
}