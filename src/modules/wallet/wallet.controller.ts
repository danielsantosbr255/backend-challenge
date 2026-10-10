import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreateWalletUseCase } from './use-cases/create-wallet.use-case';
import { QueryWalletUseCase } from './use-cases/query-wallet.use-case';
import { Money } from './domain/money';
import { CreateWalletRequestDto } from './dtos/create-wallet.dto';
import type { CreateWalletResponseDto } from './dtos/create-wallet-response.dto';
import { parseLedgerCursor } from './dtos/list-wallet-ledger-query.dto';
import type {
  WalletLedgerResponseDto,
  WalletReconciliationResponseDto,
  WalletResponseDto,
} from './dtos/wallet-query-response.dto';
import { ReconcileWalletRequestDto } from './dtos/reconcile-wallet.dto';

// Apply the external provider identity guard here if authentication is added.
@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly queryWallet: QueryWalletUseCase,
  ) {}

  @Get(':walletId')
  async get(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<WalletResponseDto> {
    return this.queryWallet.get(walletId);
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): Promise<WalletLedgerResponseDto> {
    if (limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100');
    return this.queryWallet.getLedger(walletId, parseLedgerCursor(cursor), limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body() request: ReconcileWalletRequestDto,
  ): Promise<WalletReconciliationResponseDto> {
    if (request.walletId !== walletId) throw new BadRequestException('walletId must match the route parameter');
    return this.queryWallet.reconcile(walletId);
  }

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
