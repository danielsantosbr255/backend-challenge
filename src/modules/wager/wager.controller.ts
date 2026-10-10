import { BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Money } from '@/modules/wallet/domain/money';
import { ProcessWagerUseCase } from './use-cases/process-wager.use-case';
import {
  IDEMPOTENCY_KEY_PATTERN,
  ProcessWagerRequestDto,
  type ProcessWagerResponseDto,
} from './dtos/process-wager.dto';

@Controller('wagering/transactions')
export class WagerController {
  constructor(private readonly processWager: ProcessWagerUseCase) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async process(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() request: ProcessWagerRequestDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProcessWagerResponseDto> {
    if (idempotencyKey === undefined || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }

    const result = await this.processWager.execute({
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      idempotencyKey,
      playerId: request.playerId,
      walletId: request.walletId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: request.kind,
      money: Money.from(request.money),
      ...(request.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: request.referenceExternalTransactionId }),
    });
    response.status(result.status === 'REJECTED' ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.OK);
    return result;
  }
}
