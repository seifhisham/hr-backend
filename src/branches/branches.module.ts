import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { BranchesService } from './branches.service.js';
import { BranchesController } from './branches.controller.js';
@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [BranchesService],
  controllers: [BranchesController],
})
export class BranchesModule {}
