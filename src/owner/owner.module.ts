import { Module } from '@nestjs/common';
import { OwnerService } from './owner.service.js';
import { OwnerController, OnboardingController } from './owner.controller.js';
@Module({
  providers: [OwnerService],
  controllers: [OwnerController, OnboardingController],
  exports: [OwnerService],
})
export class OwnerModule {}
