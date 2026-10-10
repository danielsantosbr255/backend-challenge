import { Inject, Injectable } from '@nestjs/common';
import { WAGER_REPOSITORY, type WagerRepositoryInterface } from '../wager.interface';
import { WagerTransactionNotFoundError } from '../wager.errors';
import type { WagerTransactionQueryResponseDto } from '../dtos/wager-transaction-query.dto';

@Injectable()
export class QueryWagerTransactionUseCase {
  constructor(@Inject(WAGER_REPOSITORY) private readonly repository: WagerRepositoryInterface) {}

  async byId(transactionId: string): Promise<WagerTransactionQueryResponseDto> {
    return toResponse(await this.repository.findTransaction(transactionId));
  }

  async byProvider(providerId: string, externalTransactionId: string): Promise<WagerTransactionQueryResponseDto> {
    return toResponse(await this.repository.findProviderTransaction(providerId, externalTransactionId));
  }
}

function toResponse(transaction: Awaited<ReturnType<WagerRepositoryInterface['findTransaction']>>): WagerTransactionQueryResponseDto {
  if (transaction === undefined) throw new WagerTransactionNotFoundError();
  return {
    transactionId: transaction.transactionId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money,
    ...(transaction.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    ...(transaction.responseBalance === undefined ? {} : { balance: transaction.responseBalance }),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt === undefined ? {} : { processedAt: transaction.processedAt.toISOString() }),
  };
}
