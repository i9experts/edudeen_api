import {
  Controller,
  Get,
  Post,
  Body,
  Put,
  Param,
  Delete,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { FaqService } from './faq.service';
import { CreateFaqDto, UpdateFaqDto } from './dto/faq.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('FAQs')
@Controller('api/faqs')
export class FaqController {
  constructor(private readonly faqService: FaqService) {}

  // ============================================================
  // PUBLIC ENDPOINTS (No Auth)
  // ============================================================

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all active FAQs (public)' })
  @ApiQuery({
    name: 'category',
    required: false,
    example: 'account',
    description: 'Filter by category',
  })
  @ApiResponse({
    status: 200,
    description: 'FAQs retrieved successfully',
    schema: {
      example: {
        success: true,
        count: 5,
        data: [
          {
            _id: '...',
            question: 'How do I reset my password?',
            answer: 'Click on forgot password...',
            category: 'account',
            order: 1,
            isActive: true,
          },
        ],
      },
    },
  })
  getActiveFaqs(@Query('category') category?: string) {
    return this.faqService.findAllActive(category);
  }

  @Get('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Search FAQs (public)' })
  @ApiQuery({ name: 'q', required: true, example: 'password reset' })
  @ApiResponse({
    status: 200,
    description: 'Search results',
    schema: {
      example: {
        success: true,
        count: 2,
        query: 'password reset',
        data: [],
      },
    },
  })
  searchFaqs(@Query('q') query: string) {
    return this.faqService.search(query);
  }

  @Get('categories')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all FAQ categories (public)' })
  @ApiResponse({
    status: 200,
    description: 'Categories retrieved',
    schema: {
      example: {
        success: true,
        count: 3,
        data: ['account', 'billing', 'general'],
      },
    },
  })
  getCategories() {
    return this.faqService.getCategories();
  }

  // ============================================================
  // ADMIN ENDPOINTS (Auth Required)
  // ============================================================

  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all FAQs including inactive (admin)' })
  @ApiResponse({
    status: 200,
    description: 'All FAQs retrieved',
    schema: {
      example: {
        success: true,
        count: 10,
        stats: { active: 8, inactive: 2 },
        data: [],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getAll() {
    return this.faqService.findAll();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create new FAQ (admin)' })
  @ApiResponse({
    status: 201,
    description: 'FAQ created successfully',
    schema: {
      example: {
        success: true,
        message: 'FAQ created successfully',
        data: {
          _id: '...',
          question: 'New question?',
          answer: 'Answer here',
          category: 'general',
          order: 0,
          isActive: true,
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  create(@Body() dto: CreateFaqDto) {
    return this.faqService.create(dto);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update FAQ (admin)' })
  @ApiParam({ name: 'id', description: 'FAQ ID' })
  @ApiResponse({
    status: 200,
    description: 'FAQ updated successfully',
    schema: {
      example: {
        success: true,
        message: 'FAQ updated successfully',
        data: {},
      },
    },
  })
  @ApiResponse({ status: 404, description: 'FAQ not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  update(@Param('id') id: string, @Body() dto: UpdateFaqDto) {
    return this.faqService.update(id, dto);
  }

  @Put(':id/toggle')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle FAQ active status (admin)' })
  @ApiParam({ name: 'id', description: 'FAQ ID' })
  @ApiResponse({
    status: 200,
    description: 'FAQ status toggled',
    schema: {
      example: {
        success: true,
        message: 'FAQ activated successfully',
        data: { _id: '...', isActive: true },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'FAQ not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  toggle(@Param('id') id: string) {
    return this.faqService.toggleActive(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete FAQ (admin)' })
  @ApiParam({ name: 'id', description: 'FAQ ID' })
  @ApiResponse({
    status: 200,
    description: 'FAQ deleted successfully',
    schema: {
      example: {
        success: true,
        message: 'FAQ deleted successfully',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'FAQ not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  remove(@Param('id') id: string) {
    return this.faqService.remove(id);
  }
}
