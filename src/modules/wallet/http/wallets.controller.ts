import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Body,
} from '@nestjs/common';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import { WalletAlreadyExistsError } from '../application/wallet-creation.store';
import { InvalidMoneyError, Money } from '../domain/money';
import { InvalidWalletError } from '../domain/wallet';
import { CreateWalletRequest } from './create-wallet.request';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWallet: CreateWalletUseCase) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() request: CreateWalletRequest) {
    try {
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
    } catch (error: unknown) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException('Wallet already exists for player and currency');
      }
      if (error instanceof InvalidMoneyError || error instanceof InvalidWalletError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
