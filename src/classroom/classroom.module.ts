/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ProductsModule } from '../products/product.module';
import { ProductQuestion, ProductQuestionSchema } from './schemas/product-question.schema';
import { ProductQuestionsService } from './product-questions.service';
import { BundlesService } from './bundles.service';
import { CuratedCollectionsService } from './curated-collections.service';
import { CoursesService } from './courses.service';
import { CourseProgress, CourseProgressSchema } from './schemas/course.schema';
import { UploadModule } from '../upload/upload.module';
import { CuratedCollection, CuratedCollectionSchema } from './schemas/curated-collection.schema';
import { LearningPath, LearningPathSchema } from './schemas/learning-path.schema';
import { LearningPathsService } from './learning-paths.service';
import { AdminLearningPathsController, LearningPathsController } from './learning-paths.controller';
import { AdminCuratedCollectionsController, BundlesController, CoursesController, CuratedCollectionsController, ProductQuestionsController } from './classroom.controllers';

/**
 * Teacher- and school-facing features that sit beside the catalogue:
 * product Q&A, bundles, Edudeen's curated shelves, and online courses.
 */
@Module({
  imports: [
    AuthModule,
    RedisModule,
    ProductsModule,
    UploadModule,
    MongooseModule.forFeature([
      { name: ProductQuestion.name, schema: ProductQuestionSchema },
      { name: CuratedCollection.name, schema: CuratedCollectionSchema },
      { name: CourseProgress.name, schema: CourseProgressSchema },
      { name: LearningPath.name, schema: LearningPathSchema },
    ]),
  ],
  controllers: [ProductQuestionsController, BundlesController, CuratedCollectionsController, AdminCuratedCollectionsController, CoursesController, LearningPathsController, AdminLearningPathsController],
  providers: [ProductQuestionsService, BundlesService, CuratedCollectionsService, CoursesService, LearningPathsService],
})
export class ClassroomModule {}
