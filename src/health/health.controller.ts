import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  getLive() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async getReady(@Res({ passthrough: true }) response: Response) {
    const result = await this.healthService.checkReadiness();

    if (!result.isReady) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'error',
        details: result.details,
        errors: result.errors,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      status: 'ok',
      details: result.details,
      timestamp: new Date().toISOString(),
    };
  }
}
