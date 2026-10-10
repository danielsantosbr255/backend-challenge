import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CreateWalletUseCase } from './use-cases/create-wallet.use-case';
import { Money } from './domain/money';
import { CreateWalletRequestDto, type CreateWalletResponseDto } from './dtos/create-wallet.dto';

@Controller('wallets')
export class WalletController {
  constructor(private readonly createWallet: CreateWalletUseCase) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() request: CreateWalletRequestDto): Promise<CreateWalletResponseDto> {
    const wallet = await this.createWallet.execute({
      playerId: request.playerId,
      initialBalance: Money.from(request.initialBalance),
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
