/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ChildInput, ChildrenService } from './children.service';

/** "My children" - buyer-only CRUD on the logged-in buyer's own child profiles. */
@Controller('api/children')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
export class ChildrenController {
  constructor(private readonly children: ChildrenService) {}

  @Get() list(@Req() req: any) { return this.children.list(req.user.userId); }
  @Post() create(@Req() req: any, @Body() body: ChildInput) { return this.children.create(req.user.userId, body); }
  @Patch(':id') update(@Req() req: any, @Param('id') id: string, @Body() body: ChildInput) { return this.children.update(req.user.userId, id, body); }
  @Delete(':id') remove(@Req() req: any, @Param('id') id: string) { return this.children.remove(req.user.userId, id); }
}
