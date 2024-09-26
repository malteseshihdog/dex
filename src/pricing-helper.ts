import {
  Address,
  LoggerConstructor,
  Logger,
  Token,
  PoolPrices,
  ExchangePrices,
  UnoptimizedRate,
  TransferFeeParams,
  ImprovedPoolPrices,
  ImprovedPoolPrice,
  toImprovedPoolPrices,
} from './types';
import {
  SwapSide,
  SETUP_RETRY_TIMEOUT,
  FETCH_POOL_IDENTIFIER_TIMEOUT,
  FETCH_POOL_PRICES_TIMEOUT,
} from './constants';
import { DexAdapterService } from './dex';
import { IDex, IRouteOptimizer } from './dex/idex';
import { isSrcTokenTransferFeeToBeExchanged } from './utils';

export class PricingHelper {
  logger: Logger;
  public optimizeRate: IRouteOptimizer<UnoptimizedRate>;

  constructor(
    protected dexAdapterService: DexAdapterService,
    loggerConstructor: LoggerConstructor,
  ) {
    this.logger = loggerConstructor(
      `PricingHelper_${dexAdapterService.network}`,
    );
    this.optimizeRate = (ur: UnoptimizedRate) =>
      this.dexAdapterService.routeOptimizers.reduce(
        (acc: UnoptimizedRate, fn: IRouteOptimizer<UnoptimizedRate>) => fn(acc),
        ur,
      );
  }

  private async initializeDex(dexKey: string, blockNumber: number) {
    try {
      const dexInstance = this.dexAdapterService.getDexByKey(dexKey);

      if (!dexInstance.initializePricing) return;

      if (
        !this.dexAdapterService.dexHelper.config.isSlave &&
        dexInstance.cacheStateKey
      ) {
        this.logger.info(`remove cached state ${dexInstance.cacheStateKey}`);
        this.dexAdapterService.dexHelper.cache.rawdel(
          dexInstance.cacheStateKey,
        );
      }

      await dexInstance.initializePricing(blockNumber);
      this.logger.info(`${dexKey}: is successfully initialized`);
    } catch (e) {
      this.logger.error(`Error_startListening_${dexKey}:`, e);
      setTimeout(
        () => this.initializeDex(dexKey, blockNumber),
        SETUP_RETRY_TIMEOUT,
      );
    }
  }

  public getAllDexKeys(): string[] {
    return this.dexAdapterService.getAllDexKeys();
  }

  public getDexByKey(key: string): IDex<any, any, any> | null {
    try {
      return this.dexAdapterService.getDexByKey(key);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Invalid Dex Key')) {
        this.logger.warn(`Dex ${key} was not found in getDexByKey`);
        return null;
      }
      // Unexpected error
      throw e;
    }
  }

  public async initialize(blockNumber: number, dexKeys: string[]) {
    return await Promise.all(
      dexKeys.map(key => this.initializeDex(key, blockNumber)),
    );
  }

  public async releaseResources(dexKeys: string[]) {
    return await Promise.all(dexKeys.map(key => this.releaseDexResources(key)));
  }

  private async releaseDexResources(dexKey: string) {
    try {
      const dexInstance = this.dexAdapterService.getDexByKey(dexKey);

      if (!dexInstance.releaseResources) return;

      await dexInstance.releaseResources();
      this.logger.info(`${dexKey}: resources were successfully released`);
    } catch (e) {
      this.logger.error(`Error_releaseResources_${dexKey}:`, e);
      setTimeout(() => this.releaseDexResources(dexKey), SETUP_RETRY_TIMEOUT);
    }
  }

  public async getPoolIdentifiers(
    from: Token,
    to: Token,
    side: SwapSide,
    blockNumber: number,
    dexKeys: string[],
    filterConstantPricePool: boolean = false,
  ): Promise<{ [dexKey: string]: string[] | null }> {
    const poolIdentifiers = await Promise.all(
      dexKeys.map(async key => {
        try {
          return await new Promise<string[] | null>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Timeout`)),
              FETCH_POOL_IDENTIFIER_TIMEOUT,
            );
            const dexInstance = this.dexAdapterService.getDexByKey(key);

            if (
              filterConstantPricePool &&
              dexInstance.hasConstantPriceLargeAmounts
            ) {
              clearTimeout(timer);
              return resolve(null);
            }

            return dexInstance
              .getPoolIdentifiers(from, to, side, blockNumber)
              .then(resolve, reject)
              .finally(() => {
                clearTimeout(timer);
              });
          });
        } catch (e) {
          this.logger.error(`Error_${key}_getPoolIdentifiers:`, e);
          return [];
        }
      }),
    );

    return dexKeys.reduce(
      (
        acc: { [dexKey: string]: string[] | null },
        dexKey: string,
        index: number,
      ) => {
        acc[dexKey] = poolIdentifiers[index];
        return acc;
      },
      {},
    );
  }

  getDexsSupportingFeeOnTransfer(): string[] {
    const allDexKeys = this.dexAdapterService.getAllDexKeys();
    return allDexKeys
      .map(dexKey => {
        try {
          const dexInstance = this.dexAdapterService.getDexByKey(dexKey);
          if (dexInstance.isFeeOnTransferSupported) {
            return dexKey;
          }
        } catch (e) {
          if (
            !(e instanceof Error && e.message.startsWith(`Invalid Dex Key`))
          ) {
            throw e;
          }
        }
      })
      .filter((d: string | undefined): d is string => !!d);
  }

  public async getPoolPrices(
    from: Token,
    to: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    dexKeys: string[],
    limitPoolsMap: { [key: string]: string[] | null } | null,
    transferFees: TransferFeeParams = {
      srcFee: 0,
      destFee: 0,
      srcDexFee: 0,
      destDexFee: 0,
    },
    rollupL1ToL2GasRatio?: number,
  ): Promise<ImprovedPoolPrices<any>> {
    const dexPoolPrices = await Promise.all(
      dexKeys.map(async key => {
        try {
          const limitPools = limitPoolsMap ? limitPoolsMap[key] : null;

          if (limitPools && !limitPools.length) return [];

          return await new Promise<ImprovedPoolPrices<any>>(
            (resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error(`Timeout`)),
                FETCH_POOL_PRICES_TIMEOUT,
              );

              const dexInstance = this.dexAdapterService.getDexByKey(key);

              if (
                isSrcTokenTransferFeeToBeExchanged(transferFees) &&
                !dexInstance.isFeeOnTransferSupported
              ) {
                clearTimeout(timer);
                return resolve([
                  {
                    dexKey: key,
                    poolId: 'isSrcTokenTransferFeeToBeExchanged_pool',
                    prices: null,
                  },
                ]);
              }

              dexInstance
                .getPricesVolume(
                  from,
                  to,
                  amounts,
                  side,
                  blockNumber,
                  limitPools ? limitPools : undefined,
                  transferFees,
                )
                .then(poolPrices => {
                  // TODO-rec: refactor
                  const improvedPrices = toImprovedPoolPrices(key, poolPrices);
                  if (!rollupL1ToL2GasRatio) {
                    return resolve(improvedPrices);
                  }
                  try {
                    return resolve(
                      improvedPrices.map(pp => {
                        if (pp.prices === null) {
                          return pp;
                        }
                        pp.prices.gasCostL2 = pp.prices.gasCost;
                        const gasCostL1 = dexInstance.getCalldataGasCost(
                          pp.prices,
                        );
                        if (
                          typeof pp.prices.gasCost === 'number' &&
                          typeof gasCostL1 === 'number'
                        ) {
                          pp.prices.gasCost += Math.ceil(
                            rollupL1ToL2GasRatio * gasCostL1,
                          );
                        } else if (
                          typeof pp.prices.gasCost !== 'number' &&
                          typeof gasCostL1 !== 'number'
                        ) {
                          if (pp.prices.gasCost.length !== gasCostL1.length) {
                            throw new Error(
                              `getCalldataGasCost returned wrong array length in dex ${key}`,
                            );
                          }
                          pp.prices.gasCost = pp.prices.gasCost.map(
                            (g, i) =>
                              g +
                              Math.ceil(rollupL1ToL2GasRatio * gasCostL1[i]),
                          );
                        } else {
                          throw new Error(
                            `getCalldataGasCost returned wrong type in dex ${key}`,
                          );
                        }
                        return pp;
                      }),
                    );
                  } catch (e) {
                    reject(e);
                  }
                }, reject)
                .finally(() => {
                  clearTimeout(timer);
                });
            },
          );
        } catch (e) {
          this.logger.error(`Error_${key}_getPoolPrices:`, e);
          // TODO-rec: check if timeout should be the reason for dex excluding
          return [
            {
              dexKey: key,
              poolId: (e as unknown as Error).message ?? 'Error_getPoolPrices',
              prices: null,
            },
          ];
        }
      }),
    );

    return (
      dexPoolPrices
        // TODO-rec: ignore for now as we return all available prices & pools
        // .filter((x): x is ExchangePrices<any> => !!x)
        .flat() // flatten to get all the pools for the swap
        .filter(p => {
          if (p.prices === null) {
            return true;
          }
          // Pools should only return correct chunks
          if (p.prices.prices.length !== amounts.length) {
            this.logger.error(
              `Error_getPoolPrices: ${p.prices.exchange} returned prices with invalid chunks`,
            );
            return false;
          }

          if (Array.isArray(p.prices.gasCost)) {
            if (p.prices.gasCost.length !== amounts.length) {
              this.logger.error(
                `Error_getPoolPrices: ${p.prices.exchange} returned prices with invalid gasCost array length: ${p.prices.gasCost.length} !== ${amounts.length}`,
              );
              return false;
            }

            for (const [i, amount] of amounts.entries()) {
              if (amount === 0n && p.prices.gasCost[i] !== 0) {
                this.logger.error(
                  `Error_getPoolPrices: ${p.prices.exchange} returned prices with invalid gasCost array. At index ${i} amount is 0 but gasCost is ${p.prices.gasCost[i]}`,
                );
                return false;
              }
            }
          }

          if (p.prices.prices.every(pi => pi === 0n)) {
            this.logger.error(
              `Error_getPoolPrices: ${p.prices.exchange} returned all 0n prices`,
            );
            return false;
          }
          return true;
        })
    );
  }
}
