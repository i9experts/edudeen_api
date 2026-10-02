/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ProductsModule } from '../products/product.module';
import { SavedList, SavedListSchema } from './schemas/saved-list.schema';
import { ProductQuestion, ProductQuestionSchema } from './schemas/product-question.schema';
import { QuoteRequest, QuoteRequestSchema } from './schemas/quote-request.schema';
import { SavedListsService } from './saved-lists.service';
import { ProductQuestionsService } from './product-questions.service';
import { QuoteRequestsService } from './quote-requests.service';
import { BundlesService } from './bundles.service';
import { CuratedCollectionsService } from './curated-collections.service';
import { CoursesService } from './courses.service';
import { CourseProgress, CourseProgressSchema } from './schemas/course.schema';
import { UploadModule } from '../upload/upload.module';
import { CuratedCollection, CuratedCollectionSchema } from './schemas/curated-collection.schema';
import { AdminCuratedCollectionsController, BundlesController, CoursesController, CuratedCollectionsController, ProductQuestionsController, QuoteRequestsController, SavedListsController } from './classroom.controllers';

/**
 * Teacher- and school-facing features that sit beside the catalogue:
 * shareable resource lists, product Q&A, bulk quote requests, bundles, Edudeen's curated shelves, and online courses / live classes.
 */
@Module({
  imports: [
    AuthModule,
    RedisModule,
    ProductsModule,
    UploadModule,
    MongooseModule.forFeature([
      { name: SavedList.name, schema: SavedListSchema },
      { name: ProductQuestion.name, schema: ProductQuestionSchema },
      { name: QuoteRequest.name, schema: QuoteRequestSchema },
      { name: CuratedCollection.name, schema: CuratedCollectionSchema },
      { name: CourseProgress.name, schema: CourseProgressSchema },
    ]),
  ],
  controllers: [SavedListsController, ProductQuestionsController, QuoteRequestsController, BundlesController, CuratedCollectionsController, AdminCuratedCollectionsController, CoursesController],
  providers: [SavedListsService, ProductQuestionsService, QuoteRequestsService, BundlesService, CuratedCollectionsService, CoursesService],
})
export class ClassroomModule {}
