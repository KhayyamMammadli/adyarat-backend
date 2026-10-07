import { TelegramVacancyManagementService } from './telegram-vacancy-management.service';
import { TelegramInvitationService } from './telegram-invitation.service';
import { TelegramStaffService } from './telegram-staff.service';
import { TelegramStaffMenuService } from './telegram-staff-menu.service';
import { Module } from '@nestjs/common';
import { JobAgentModule } from '../job-agent/job-agent.module';
import { TelegramAdminService } from './telegram-admin.service';
import { TelegramAdminStateService } from './telegram-admin-state.service';
import { TelegramJobAdminService } from './telegram-job-admin.service';
import { TelegramTransportModule } from './telegram-transport.module';
import { TelegramController } from './telegram.controller';

@Module({
  imports: [JobAgentModule, TelegramTransportModule],
  controllers: [TelegramController],
  providers: [
    TelegramVacancyManagementService,
    TelegramInvitationService,
    TelegramStaffService,
    TelegramStaffMenuService,
    TelegramAdminService,
    TelegramAdminStateService,
    TelegramJobAdminService,
  ],
  exports: [TelegramAdminService],
})
export class TelegramModule {}
