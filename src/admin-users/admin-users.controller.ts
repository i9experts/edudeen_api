/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Get, Param, Patch, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ParseObjectIdPipe } from '../common/parse-object-id.pipe';
import { AdminUsersService } from './admin-users.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';

@ApiTags('Admin Users & Sellers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/users')
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  private meta(req: any) {
    return { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  private validateRole(role: string): 'buyer' | 'seller' {
    if (role !== 'buyer' && role !== 'seller') {
      throw new BadRequestException('role must be "buyer" or "seller"');
    }
    return role;
  }

  @Get('stats')
  getStats() {
    return this.adminUsersService.getStats();
  }

  @Get()
  list(@Query() query: AdminUsersQueryDto) {
    return this.adminUsersService.list(query);
  }

  @Get(':role/:id')
  getById(@Param('role') role: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminUsersService.getById(this.validateRole(role), id);
  }

  @Patch(':role/:id/suspend')
  suspend(@Req() req: any, @Param('role') role: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminUsersService.suspend(this.validateRole(role), id, this.meta(req));
  }

  @Patch(':role/:id/unsuspend')
  unsuspend(@Req() req: any, @Param('role') role: string, @Param('id', ParseObjectIdPipe) id: string) {
    return this.adminUsersService.unsuspend(this.validateRole(role), id, this.meta(req));
  }
}
