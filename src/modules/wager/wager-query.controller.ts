import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { QueryWagerTransactionUseCase } from './use-cases/query-wager-transaction.use-case';
import type { WagerTransactionQueryResponseDto } from './dtos/wager-transaction-query.dto';

// Apply the external provider identity guard here if authentication is added.
@Controller()
export class WagerQueryController {
  constructor(private readonly queryTransaction: QueryWagerTransactionUseCase) {}

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', ParseUUIDPipe) transactionId: string): Promise<WagerTransactionQueryResponseDto> {
    return this.queryTransaction.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionQueryResponseDto> {
    return this.queryTransaction.byProvider(providerId, externalTransactionId);
  }
}
