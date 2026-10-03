import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service.js';
import { DatabaseService } from './database.service.js';

@Module({
  providers: [DatabaseService, BootstrapService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
