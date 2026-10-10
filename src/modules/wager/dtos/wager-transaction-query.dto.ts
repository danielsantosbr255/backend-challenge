export interface WagerTransactionQueryResponseDto {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  failureCode?: string;
  balance?: { amount: string; currency: string };
  createdAt: string;
  processedAt?: string;
}
