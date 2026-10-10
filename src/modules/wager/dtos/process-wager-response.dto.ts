import type { MoneyProps } from '@/modules/wallet/domain/money';

export interface ProcessWagerResponseDto {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}
