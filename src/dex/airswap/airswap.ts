import {
  ExchangeTxInfo,
  PreprocessTransactionOptions,
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
  OptimalSwapExchange,
} from '../../types';

import { SwapSide, Network, ETHER_ADDRESS } from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getDexKeysWithNetwork } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { AirswapData } from './types';
import { SimpleExchange } from '../simple-exchange';
import { AirSwapConfig, Adapters } from './config';
import { Interface } from 'ethers/lib/utils';
import ethers from 'ethers';
import { AddressZero } from '@ethersproject/constants';

import erc20ABI from '@airswap/swap-erc20/build/contracts/SwapERC20.sol/SwapERC20.json' assert { type: `json` };
import { getMakersLocatorForTX, getStakersUrl, getTx } from './airswap-tools';
import { BN_1, getBigNumberPow } from '../../bignumber-constants';
import BigNumber from 'bignumber.js';

type temporaryMakerAnswer = {
  pairs: [
    {
      baseToken: string;
      quoteToken: string;
    },
  ];
};

export class Airswap extends SimpleExchange implements IDex<AirswapData> {
  private makers: any;

  readonly hasConstantPriceLargeAmounts = false;
  // TODO: set true here if protocols works only with wrapped asset
  readonly needWrapNative = true;
  readonly isFeeOnTransferSupported = false;

  private localProvider: ethers.providers.InfuraWebSocketProvider;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(AirSwapConfig);

  logger: Logger;

  constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
    protected adapters = Adapters[network] || {}, // TODO: add any additional optional params to support other fork DEXes
    readonly routerAddress: string = AirSwapConfig.Airswap[network].swapERC20,
    protected routerInterface = new Interface(JSON.stringify(erc20ABI)),
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    this.localProvider = new ethers.providers.InfuraWebSocketProvider(
      this.dexHelper.config.data.network,
      process.env.INFURA_KEY,
    );
  }

  // Initialize pricing is called once in the start of
  // pricing service. It is intended to setup the integration
  // for pricing requests. It is optional for a DEX to
  // implement this function
  async initializePricing(blockNumber: number) {
    // @TODO Put in cache data to build a map of makers that we will poll
    // get all satkers url for last look cahce, need to connect to any adresses below
    this.makers = await getStakersUrl(
      this.localProvider,
      AirSwapConfig.Airswap[this.network].makerRegistry,
    );
    console.log('[AIRSWAP]', 'makers:', this.makers);
  }

  // Returns the list of contract adapters (name and index)
  // for a buy/sell. Return null if there are no adapters.
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters[side] ? this.adapters[side] : null;
  }

  forgePairTokenKey = (srcAddress: Address, destAddress: Address) =>
    `${srcAddress}_${destAddress}`.toLowerCase();

  getPoolIdentifier(
    srcAddress: Address,
    destAddress: Address,
    makerName: string = '',
  ) {
    const pairTokenKey = this.forgePairTokenKey(srcAddress, destAddress);
    return `${this.dexKey}_${pairTokenKey}_${makerName}`.toLowerCase();
  }

  getMakerUrlFromKey(key: string) {
    return key.split(`_`).pop();
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const normalizedSrcToken = this.normalizeToken(srcToken);
    const normalizedDestToken = this.normalizeToken(destToken);

    if (normalizedSrcToken.address === normalizedDestToken.address) {
      return [];
    }

    const makerAndPairs: Record<string, temporaryMakerAnswer> = {
      'http://airswap-goerli-maker.mitsi.ovh': {
        pairs: [
          {
            baseToken: '0x79c950c7446b234a6ad53b908fbf342b01c4d446',
            quoteToken: '0x07865c6E87B9F70255377e024ace6630C1Eaa37F',
          },
        ],
      },
    };
    const makers = Object.keys(makerAndPairs);

    return makers
      .filter((makerName: string) => {
        const pairs = makerAndPairs[makerName].pairs ?? [];
        return pairs.some(
          pair =>
            normalizedSrcToken.address === pair.baseToken.toLowerCase() &&
            normalizedDestToken.address === pair.quoteToken.toLowerCase(),
        );
      })
      .map(makerName =>
        this.getPoolIdentifier(
          normalizedSrcToken.address,
          normalizedDestToken.address,
          makerName,
        ),
      );
  }

  // Returns pool prices for amounts.
  // If limitPools is defined only pools in limitPools
  // should be used. If limitPools is undefined then
  // any pools can be used.
  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<AirswapData>> {
    const normalizedSrcToken = this.normalizeToken(srcToken);
    const normalizedDestToken = this.normalizeToken(destToken);

    if (normalizedSrcToken.address === normalizedDestToken.address) {
      return null;
    }

    const pools =
      limitPools ??
      (await this.getPoolIdentifiers(srcToken, destToken, side, blockNumber));

    const marketMakersUris = pools.map(this.getMakerUrlFromKey);
    // get pricing to corresponding pair token for each maker
    const levelRequests = marketMakersUris.map(url => ({
      maker: url,
      level: airswapApi.getOptimisticLevel(maker, srcToken, destToken),
    }));
    const levels = await Promise.all(levelRequests);
    const prices = levels.map(({ maker, level }) => {
      const divider = getBigNumberPow(
        side === SwapSide.SELL
          ? normalizedSrcToken.decimals
          : normalizedDestToken.decimals,
      );

      const amountsRaw = amounts.map(amount =>
        new BigNumber(amount.toString()).dividedBy(divider),
      );

      const unitPrice = this.computePricesFromLevels(
        [BN_1],
        level,
        normalizedSrcToken,
        normalizedDestToken,
        side,
      )[0];
      const prices = this.computePricesFromLevels(
        amountsRaw,
        level,
        normalizedSrcToken,
        normalizedDestToken,
        side,
      );

      return {
        gasCost: 100_000, // where does it comes from ?
        exchange: this.dexKey,
        data: { maker },
        prices,
        unit: unitPrice,
        poolIdentifier: this.getPoolIdentifier(
          normalizedSrcToken.address,
          normalizedDestToken.address,
          maker,
        ),
        poolAddresses: [this.routerAddress],
      }; // as PoolPrices<AirswapData>;
    });

    return null;
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(poolPrices: PoolPrices<AirswapData>): number | number[] {
    // TODO: update if there is any payload in getAdapterParam
    return CALLDATA_GAS_COST.DEX_NO_PAYLOAD;
  }

  // Encode params required by the exchange adapter
  // Used for multiSwap, buy & megaSwap
  // Hint: abiCoder.encodeParameter() could be useful
  // @TODO PARASWAP
  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AirswapData,
    side: SwapSide,
  ): AdapterExchangeParam {
    // TODO: complete me!
    const { exchange } = data;

    // Encode here the payload for adapter
    const payload = '';

    return {
      targetExchange: exchange,
      payload,
      networkFee: '0',
    };
  }

  // Encode call data used by simpleSwap like routers
  // Used for simpleSwap & simpleBuy
  // Hint: this.buildSimpleParamWithoutWETHConversion
  // could be useful
  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AirswapData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    // TODO: complete me!
    const { exchange } = data;

    // Encode here the transaction arguments
    const swapData = '';

    return this.buildSimpleParamWithoutWETHConversion(
      srcToken,
      srcAmount,
      destToken,
      destAmount,
      swapData,
      exchange,
    );
  }

  // This is optional function in case if your implementation has acquired any resources
  // you need to release for graceful shutdown. For example, it may be any interval timer
  releaseResources(): Promise<void> {
    return Promise.resolve();
  }

  isBlacklisted(userAddress?: string | undefined): Promise<boolean> {
    return Promise.resolve(false);
  }

  // change 0xeee burn address to native 0x000
  normalizeToken(token: Token): Token {
    return {
      address:
        token.address.toLowerCase() === ETHER_ADDRESS
          ? AddressZero
          : token.address.toLowerCase(),
      decimals: token.decimals,
    };
  }

  async preProcessTransaction(
    optimalSwapExchange: OptimalSwapExchange<AirswapData>,
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    options: PreprocessTransactionOptions,
  ): Promise<[OptimalSwapExchange<AirswapData>, ExchangeTxInfo]> {
    if (await this.isBlacklisted(options.txOrigin)) {
      this.logger.warn(
        `${this.dexKey}-${this.network}: blacklisted TX Origin address '${options.txOrigin}' trying to build a transaction. Bailing...`,
      );
      throw new Error(
        `${this.dexKey}-${
          this.network
        }: user=${options.txOrigin.toLowerCase()} is blacklisted`,
      );
    }

    const normalizedSrcToken = this.normalizeToken(srcToken);
    const normalizedDestToken = this.normalizeToken(destToken);

    const amount =
      side === SwapSide.SELL
        ? optimalSwapExchange.srcAmount
        : optimalSwapExchange.destAmount;

    const makers = await getMakersLocatorForTX(
      this.localProvider,
      normalizedSrcToken,
      normalizedDestToken,
      this.network,
    );
    const response = await Promise.race(
      makers.map(maker => {
        return getTx(
          maker.url,
          maker.swapContract,
          this.augustusAddress.toLowerCase(),
          normalizedSrcToken,
          normalizedDestToken,
          amount,
        );
      }),
    );

    return [
      {
        ...optimalSwapExchange,
        data: {
          exchange: 'i do not know what to write',
          ...response,
        },
      },
      { deadline: BigInt(response.expiry) },
    ];
  }
}
