import type { MoneyProps } from '../domain/money';

export interface CreateWalletResponseDto {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}
