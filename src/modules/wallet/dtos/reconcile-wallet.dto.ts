import { IsString, Matches } from 'class-validator';

export class ReconcileWalletRequestDto {
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  declare walletId: string;
}
