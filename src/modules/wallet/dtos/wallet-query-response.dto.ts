import type { WalletReconciliation } from '../wallet.interface';

export interface WalletResponseDto {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export interface WalletLedgerResponseDto {
  entries: Array<{
    id: string;
    transactionId: string;
    direction: 'CREDIT' | 'DEBIT';
    money: { amount: string; currency: string };
    balanceBefore: { amount: string; currency: string };
    balanceAfter: { amount: string; currency: string };
    createdAt: string;
  }>;
  nextCursor?: string;
}

export interface WalletReconciliationResponseDto extends WalletReconciliation {
  difference: { amount: string; currency: string };
  consistent: boolean;
}
