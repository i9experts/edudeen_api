import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ContactService } from './contact.service';
import { CreateContactSubmissionDto, UpdateContactStatusDto } from './dto/contact.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';

@ApiTags('Contact')
@Controller('api/contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  // ============================================================
  // PUBLIC (No Auth) — Contact Us form submission
  // ============================================================

  // Optional auth: a signed-in Premium member's message gets the priority flag. The typed email alone is NOT trusted for that.
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @ApiOperation({ summary: 'Submit the Contact Us form (public)' })
  submit(@Body() dto: CreateContactSubmissionDto, @Req() req: any) {
    const authedUserId = req?.user?.role === 'user' ? (req.user.userId as string | undefined) : undefined;
    return this.contactService.submit(dto, authedUserId);
  }

  // ============================================================
  // ADMIN (Auth Required)
  // ============================================================

  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all contact submissions (admin)' })
  getAll(@Query('priority') priority?: string) {
    return this.contactService.findAll({ priority: priority === 'true' });
  }

  @Patch('admin/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a contact submission status (admin)' })
  updateStatus(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateContactStatusDto) {
    return this.contactService.updateStatus(id, dto);
  }

  @Delete('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a contact submission (admin)' })
  remove(@Param('id', ParseObjectIdPipe) id: string) {
    return this.contactService.remove(id);
  }
}
