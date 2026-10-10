import { BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Money } from '@/modules/wallet/domain/money';
import { ProcessWagerUseCase } from './use-cases/process-wager.use-case';
import { ProcessWagerRequestDto, type ProcessWagerResponseDto } from './dtos/process-wager.dto';

@Controller('wagering/transactions')
export class WagerController {
  constructor(private readonly processWager: ProcessWagerUseCase) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async process(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() request: ProcessWagerRequestDto,
  ): Promise<ProcessWagerResponseDto> {
    if (idempotencyKey === undefined || idempotencyKey.trim().length === 0 || idempotencyKey.length > 255) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }

    return this.processWager.execute({
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
  }
}
