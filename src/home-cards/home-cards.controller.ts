import { Body, Controller, Delete, Get, Header, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { HomeCardsService } from './home-cards.service';
import { CreateHomeCardDto, ReorderHomeCardsDto, UpdateHomeCardDto } from './dto/home-card.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminReauthGuard } from '../admin-reauth/admin-reauth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';

@ApiTags('Home cards')
@Controller('api/home-cards')
export class HomeCardsController {
  constructor(private readonly service: HomeCardsService) {}

  // Public: admins change cards live, so browsers/CDNs must revalidate.
  @Header('Cache-Control', 'no-cache')
  @Get()
  listPublic() {
    return this.service.listPublic();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Get('admin/all')
  listAdmin() {
    return this.service.listAdmin();
  }

  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Post()
  create(@Body() dto: CreateHomeCardDto) {
    return this.service.create(dto);
  }

  // Declared before ':id' so "reorder" is never read as an id.
  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Patch('admin/reorder')
  reorder(@Body() dto: ReorderHomeCardsDto) {
    return this.service.reorder(dto.ids);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateHomeCardDto) {
    return this.service.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, AdminReauthGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @Delete(':id')
  remove(@Param('id', ParseObjectIdPipe) id: string) {
    return this.service.remove(id);
  }
}