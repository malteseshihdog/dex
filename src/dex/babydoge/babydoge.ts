import { AbiCoder, Interface } from '@ethersproject/abi';
import _ from 'lodash';
import { AsyncOrSync, DeepReadonly } from 'ts-essentials';
import erc20ABI from '../../abi/erc20.json';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import {
  AdapterExchangeParam,
  Address,
  ExchangePrices,
  Log,
  Logger,
  PoolLiquidity,
  PoolPrices,
  SimpleExchangeParam,
  Token,
  TxInfo,
} from '../../types';
import {
  BabydogeSwapDataLegacy,
  BabydogeSwapParam,
  BabydogeSwapPool,
  BabydogeSwapData,
  BabydogeSwapFunctions,
} from './types';
import { IDex } from '../../dex/idex';
import { ETHER_ADDRESS, Network, NULL_ADDRESS } from '../../constants';
import { SimpleExchange } from '../simple-exchange';
import { NumberAsString, SwapSide } from 'paraswap-core';
import { IDexHelper } from '../../dex-helper/idex-helper';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getDexKeysWithNetwork, isETHAddress, getBigIntPow } from '../../utils';
import BabydogeSwapABI from '../../abi/babydoge/exchange.json';
import BabydogeSwapfactoryABI from '../../abi/babydoge/factory.json';
import ParaSwapABI from '../../abi/IParaswap.json';
import BabydogeSwapExchangeRouterABI from '../../abi/babydoge/router.json';
import { Contract } from 'web3-eth-contract';
import { BabydogeSwapConfig, Adapters } from './config';

const RESERVE_LIMIT = 2n ** 112n - 1n;

const DefaultBabydogeSwapPoolGasCost = 90 * 1000;

interface BabydogeSwapPoolOrderedParams {
  tokenIn: string;
  tokenOut: string;
  reservesIn: string;
  reservesOut: string;
  fee: string;
  direction: boolean;
  exchange: string;
}

interface BabydogeSwapPoolState {
  reserves0: string;
  reserves1: string;
  feeCode: number;
}

const babydogeSwapIface = new Interface(BabydogeSwapABI);
const erc20iface = new Interface(erc20ABI);
const coder = new AbiCoder();

export const directBabydogeSwapFunctionName = [
  BabydogeSwapFunctions.swapExactTokensForTokens,
  BabydogeSwapFunctions.swapTokensForExactTokens,
];

export type BabydogeSwapPair = {
  token0: Token;
  token1: Token;
  exchange?: Address;
  pool?: BabydogeSwapEventPool;
};

const subgraphTimeout = 10 * 1000;

export class BabydogeSwapEventPool extends StatefulEventSubscriber<BabydogeSwapPoolState> {
  decoder = (log: Log) => this.iface.parseLog(log);

  constructor(
    protected parentName: string,
    protected dexHelper: IDexHelper,
    private poolAddress: Address,
    private token0: Token,
    private token1: Token,
    // feeCode is ignored if DynamicFees is set to true
    private feeCode: number,
    logger: Logger,
    private dynamicFees = false,
    // feesMultiCallData is only used if dynamicFees is set to true
    private feesMultiCallEntry?: { target: Address; callData: string },
    private feesMultiCallDecoder?: (values: any[]) => number,
    private iface: Interface = babydogeSwapIface,
  ) {
    super(
      parentName +
        ' ' +
        (token0.symbol || token0.address) +
        '-' +
        (token1.symbol || token1.address) +
        ' pool',
      logger,
    );
  }

  protected processLog(
    state: DeepReadonly<BabydogeSwapPoolState>,
    log: Readonly<Log>,
  ): AsyncOrSync<DeepReadonly<BabydogeSwapPoolState> | null> {
    const event = this.decoder(log);
    switch (event.name) {
      case 'Sync':
        return {
          reserves0: event.args.reserve0.toString(),
          reserves1: event.args.reserve1.toString(),
          feeCode: state.feeCode,
        };
    }
    return null;
  }

  async generateState(
    blockNumber: number | 'latest' = 'latest',
  ): Promise<DeepReadonly<BabydogeSwapPoolState>> {
    let calldata = [
      {
        target: this.token0.address,
        callData: erc20iface.encodeFunctionData('balanceOf', [
          this.poolAddress,
        ]),
      },
      {
        target: this.token1.address,
        callData: erc20iface.encodeFunctionData('balanceOf', [
          this.poolAddress,
        ]),
      },
    ];

    const data = await this.dexHelper.multiContract.methods
      .aggregate(calldata)
      .call({}, blockNumber);

    return {
      reserves0: coder.decode(['uint256'], data.returnData[0])[0].toString(),
      reserves1: coder.decode(['uint256'], data.returnData[1])[0].toString(),
      feeCode: this.dynamicFees
        ? this.feesMultiCallDecoder!(data.returnData[2])
        : this.feeCode,
    };
  }
}

export const BabydogeSwapExchangeRouter: { [network: number]: Address } = {
  [Network.BSC]: '0xC9a0F685F39d05D835c369036251ee3aEaaF3c47',
};

function encodePools(pools: BabydogeSwapPool[]): NumberAsString[] {
  return pools.map(({ fee, direction, address }) => {
    return (
      (BigInt(10000 - fee) << 161n) +
      ((direction ? 0n : 1n) << 160n) +
      BigInt(address)
    ).toString();
  });
}

export class BabydogeSwap
  extends SimpleExchange
  implements IDex<BabydogeSwapData, BabydogeSwapParam>
{
  pairs: { [key: string]: BabydogeSwapPair } = {};
  feeFactor = 10000;
  factory: Contract;

  routerInterface: Interface;
  exchangeRouterInterface: Interface;
  static directFunctionName = directBabydogeSwapFunctionName;

  logger: Logger;

  readonly hasConstantPriceLargeAmounts = false;
  readonly isFeeOnTransferSupported: boolean = true;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(BabydogeSwapConfig);

  constructor(
    protected network: Network,
    protected dexKey: string,
    protected dexHelper: IDexHelper,
    protected isDynamicFees = false,
    protected factoryAddress: Address = BabydogeSwapConfig[dexKey][network]
      .factoryAddress,
    protected subgraphURL: string | undefined = BabydogeSwapConfig[dexKey] &&
      BabydogeSwapConfig[dexKey][network].subgraphURL,
    protected initCode: string = BabydogeSwapConfig[dexKey][network].initCode,
    // feeCode is ignored when isDynamicFees is set to true
    protected feeCode: number = BabydogeSwapConfig[dexKey][network].feeCode,
    protected poolGasCost: number = (BabydogeSwapConfig[dexKey] &&
      BabydogeSwapConfig[dexKey][network].poolGasCost) ??
      DefaultBabydogeSwapPoolGasCost,
    protected adapters = (BabydogeSwapConfig[dexKey] &&
      BabydogeSwapConfig[dexKey][network].adapters) ??
      Adapters[network],
    protected router = (BabydogeSwapConfig[dexKey] &&
      BabydogeSwapConfig[dexKey][network].router) ??
      BabydogeSwapExchangeRouter[network],
  ) {
    super(dexHelper.config.data.augustusAddress, dexHelper.web3Provider);
    this.logger = dexHelper.getLogger(dexKey);

    this.factory = new dexHelper.web3Provider.eth.Contract(
      BabydogeSwapfactoryABI as any,
      factoryAddress,
    );

    this.routerInterface = new Interface(ParaSwapABI);
    this.exchangeRouterInterface = new Interface(BabydogeSwapExchangeRouterABI);
  }

  // getFeesMultiCallData should be override
  // when isDynamicFees is set to true
  protected getFeesMultiCallData(poolAddress: Address):
    | undefined
    | {
        callEntry: { target: Address; callData: string };
        callDecoder: (values: any[]) => number;
      } {
    return undefined;
  }

  private async addPool(
    pair: BabydogeSwapPair,
    reserves0: string,
    reserves1: string,
    feeCode: number,
    blockNumber: number,
  ) {
    const { callEntry, callDecoder } =
      this.getFeesMultiCallData(pair.exchange!) || {};
    pair.pool = new BabydogeSwapEventPool(
      this.dexKey,
      this.dexHelper,
      pair.exchange!,
      pair.token0,
      pair.token1,
      feeCode,
      this.logger,
      this.isDynamicFees,
      callEntry,
      callDecoder,
    );

    if (blockNumber)
      pair.pool.setState({ reserves0, reserves1, feeCode }, blockNumber);
    this.dexHelper.blockManager.subscribeToLogs(
      pair.pool,
      pair.exchange!,
      blockNumber,
    );
  }

  async getBuyPrice(
    priceParams: BabydogeSwapPoolOrderedParams,
    destAmount: bigint,
  ): Promise<bigint> {
    const { reservesIn, reservesOut, fee } = priceParams;

    const numerator = BigInt(reservesIn) * destAmount * BigInt(this.feeFactor);
    const denominator =
      (BigInt(this.feeFactor) - BigInt(fee)) *
      (BigInt(reservesOut) - destAmount);

    if (denominator <= 0n) return 0n;
    return numerator === 0n ? 0n : 1n + numerator / denominator;
  }

  async getSellPrice(
    priceParams: BabydogeSwapPoolOrderedParams,
    srcAmount: bigint,
  ): Promise<bigint> {
    const { reservesIn, reservesOut, fee } = priceParams;

    if (BigInt(reservesIn) + srcAmount > RESERVE_LIMIT) {
      return 0n;
    }

    const amountInWithFee = srcAmount * BigInt(this.feeFactor - parseInt(fee));

    const numerator = amountInWithFee * BigInt(reservesOut);

    const denominator =
      BigInt(reservesIn) * BigInt(this.feeFactor) + amountInWithFee;

    return denominator === 0n ? 0n : numerator / denominator;
  }

  async getBuyPricePath(
    amount: bigint,
    params: BabydogeSwapPoolOrderedParams[],
  ): Promise<bigint> {
    let price = amount;
    for (const param of params.reverse()) {
      price = await this.getBuyPrice(param, price);
    }
    return price;
  }

  async getSellPricePath(
    amount: bigint,
    params: BabydogeSwapPoolOrderedParams[],
  ): Promise<bigint> {
    let price = amount;
    for (const param of params) {
      price = await this.getSellPrice(param, price);
    }
    return price;
  }

  private async findPair(from: Token, to: Token) {
    if (from.address.toLowerCase() === to.address.toLowerCase()) return null;
    const [token0, token1] =
      from.address.toLowerCase() < to.address.toLowerCase()
        ? [from, to]
        : [to, from];

    const key = `${from.address.toLowerCase()}-${token1.address.toLowerCase()}`;
    let pair = this.pairs[key];
    if (pair) return pair;
    const exchange = await this.factory.methods
      .getPair(token0.address, token1.address)
      .call();
    if (exchange === NULL_ADDRESS) {
      pair = { token0, token1 };
    } else {
      pair = { token0, token1, exchange };
    }
    this.pairs[key] = pair;
    return pair;
  }

  async getManyPoolReserves(
    pairs: BabydogeSwapPair[],
    blockNumber: number,
  ): Promise<BabydogeSwapPoolState[]> {
    try {
      const multiCallFeeData = pairs.map(pair =>
        this.getFeesMultiCallData(pair.exchange!),
      );
      const calldata = pairs
        .map((pair, i) => {
          let calldata = [
            {
              target: pair.token0.address,
              callData: erc20iface.encodeFunctionData('balanceOf', [
                pair.exchange!,
              ]),
            },
            {
              target: pair.token1.address,
              callData: erc20iface.encodeFunctionData('balanceOf', [
                pair.exchange!,
              ]),
            },
          ];
          if (this.isDynamicFees) calldata.push(multiCallFeeData[i]!.callEntry);
          return calldata;
        })
        .flat();

      const data: { returnData: any[] } =
        await this.dexHelper.multiContract.methods
          .aggregate(calldata)
          .call({}, blockNumber);

      const returnData = _.chunk(data.returnData, this.isDynamicFees ? 3 : 2);
      return pairs.map((pair, i) => ({
        reserves0: coder.decode(['uint256'], returnData[i][0])[0].toString(),
        reserves1: coder.decode(['uint256'], returnData[i][1])[0].toString(),
        feeCode: this.isDynamicFees
          ? multiCallFeeData[i]!.callDecoder(returnData[i][2])
          : this.feeCode,
      }));
    } catch (e) {
      this.logger.error(
        `Error_getManyPoolReserves could not get reserves with error:`,
        e,
      );
      return [];
    }
  }

  async batchCatchUpPairs(pairs: [Token, Token][], blockNumber: number) {
    if (!blockNumber) return;
    const pairsToFetch: BabydogeSwapPair[] = [];
    for (const _pair of pairs) {
      const pair = await this.findPair(_pair[0], _pair[1]);
      if (!(pair && pair.exchange)) continue;
      if (!pair.pool) {
        pairsToFetch.push(pair);
      } else if (!pair.pool.getState(blockNumber)) {
        pairsToFetch.push(pair);
      }
    }

    if (!pairsToFetch.length) return;

    const reserves = await this.getManyPoolReserves(pairsToFetch, blockNumber);

    if (reserves.length !== pairsToFetch.length) {
      this.logger.error(
        `Error_getManyPoolReserves didn't get any pool reserves`,
      );
    }

    for (let i = 0; i < pairsToFetch.length; i++) {
      const pairState = reserves[i];
      const pair = pairsToFetch[i];
      if (!pair.pool) {
        await this.addPool(
          pair,
          pairState.reserves0,
          pairState.reserves1,
          pairState.feeCode,
          blockNumber,
        );
      } else pair.pool.setState(pairState, blockNumber);
    }
  }

  async getPairOrderedParams(
    from: Token,
    to: Token,
    blockNumber: number,
  ): Promise<BabydogeSwapPoolOrderedParams | null> {
    const pair = await this.findPair(from, to);
    console.log(`pair.pool : ${pair?.pool}`);
    if (!(pair && pair.pool && pair.exchange)) return null;
    const pairState = pair.pool.getState(blockNumber);
    if (!pairState) {
      this.logger.error(
        `Error_orderPairParams expected reserves, got none (maybe the pool doesn't exist) ${
          from.symbol || from.address
        } ${to.symbol || to.address}`,
      );
      return null;
    }
    const fee = pairState.feeCode.toString();
    const pairReversed =
      pair.token1.address.toLowerCase() === from.address.toLowerCase();
    if (pairReversed) {
      return {
        tokenIn: from.address,
        tokenOut: to.address,
        reservesIn: pairState.reserves1,
        reservesOut: pairState.reserves0,
        fee,
        direction: false,
        exchange: pair.exchange,
      };
    }
    return {
      tokenIn: from.address,
      tokenOut: to.address,
      reservesIn: pairState.reserves0,
      reservesOut: pairState.reserves1,
      fee,
      direction: true,
      exchange: pair.exchange,
    };
  }

  async getPoolIdentifiers(
    _from: Token,
    _to: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const from = this.dexHelper.config.wrapETH(_from);
    const to = this.dexHelper.config.wrapETH(_to);

    if (from.address.toLowerCase() === to.address.toLowerCase()) {
      return [];
    }

    const tokenAddress = [from.address.toLowerCase(), to.address.toLowerCase()]
      .sort((a, b) => (a > b ? 1 : -1))
      .join('_');

    const poolIdentifier = `${this.dexKey}_${tokenAddress}`;
    return [poolIdentifier];
  }

  async getPricesVolume(
    _from: Token,
    _to: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    // list of pool identifiers to use for pricing, if undefined use all pools
    limitPools?: string[],
  ): Promise<ExchangePrices<BabydogeSwapData> | null> {
    try {
      const from = this.dexHelper.config.wrapETH(_from);
      const to = this.dexHelper.config.wrapETH(_to);

      if (from.address.toLowerCase() === to.address.toLowerCase()) {
        return null;
      }

      const tokenAddress = [
        from.address.toLowerCase(),
        to.address.toLowerCase(),
      ]
        .sort((a, b) => (a > b ? 1 : -1))
        .join('_');

      const poolIdentifier = `${this.dexKey}_${tokenAddress}`;

      if (limitPools && limitPools.every(p => p !== poolIdentifier))
        return null;

      await this.batchCatchUpPairs([[from, to]], blockNumber);

      const pairParam = await this.getPairOrderedParams(from, to, blockNumber);
      console.log(`pairParam : ${pairParam}`);
      if (!pairParam) return null;

      const unitAmount = getBigIntPow(
        side == SwapSide.BUY ? to.decimals : from.decimals,
      );
      const unit =
        side == SwapSide.BUY
          ? await this.getBuyPricePath(unitAmount, [pairParam])
          : await this.getSellPricePath(unitAmount, [pairParam]);

      const prices =
        side == SwapSide.BUY
          ? await Promise.all(
              amounts.map(amount => this.getBuyPricePath(amount, [pairParam])),
            )
          : await Promise.all(
              amounts.map(amount => this.getSellPricePath(amount, [pairParam])),
            );

      return [
        {
          prices: prices,
          unit: unit,
          data: {
            router: this.router,
            path: [from.address.toLowerCase(), to.address.toLowerCase()],
            factory: this.factoryAddress,
            feeFactor: this.feeFactor,
            pools: [
              {
                address: pairParam.exchange,
                fee: parseInt(pairParam.fee),
                direction: pairParam.direction,
              },
            ],
          },
          exchange: this.dexKey,
          poolIdentifier,
          gasCost: this.poolGasCost,
          poolAddresses: [pairParam.exchange],
        },
      ];
    } catch (e) {
      if (blockNumber === 0)
        this.logger.error(
          `Error_getPricesVolume: Aurelius block manager not yet instantiated`,
        );
      this.logger.error(`Error_getPrices:`, e);
      return null;
    }
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(
    poolPrices: PoolPrices<BabydogeSwapData>,
  ): number | number[] {
    return CALLDATA_GAS_COST.DEX_OVERHEAD;
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters[side];
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    count: number,
  ): Promise<PoolLiquidity[]> {
    if (!this.subgraphURL) return [];
    const query = `
      query ($token: Bytes!, $count: Int) {
        pools0: pairs(first: $count, orderBy: reserveUSD, orderDirection: desc, where: {token0: $token, reserve0_gt: 1, reserve1_gt: 1}) {
        id
        token0 {
          id
          decimals
        }
        token1 {
          id
          decimals
        }
        reserveUSD
      }
      pools1: pairs(first: $count, orderBy: reserveUSD, orderDirection: desc, where: {token1: $token, reserve0_gt: 1, reserve1_gt: 1}) {
        id
        token0 {
          id
          decimals
        }
        token1 {
          id
          decimals
        }
        reserveUSD
      }
    }`;

    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      {
        query,
        variables: { token: tokenAddress.toLowerCase(), count },
      },
      subgraphTimeout,
    );

    if (!(data && data.pools0 && data.pools1))
      throw new Error("Couldn't fetch the pools from the subgraph");
    const pools0 = _.map(data.pools0, pool => ({
      exchange: this.dexKey,
      address: pool.id.toLowerCase(),
      connectorTokens: [
        {
          address: pool.token1.id.toLowerCase(),
          decimals: parseInt(pool.token1.decimals),
        },
      ],
      liquidityUSD: parseFloat(pool.reserveUSD),
    }));

    const pools1 = _.map(data.pools1, pool => ({
      exchange: this.dexKey,
      address: pool.id.toLowerCase(),
      connectorTokens: [
        {
          address: pool.token0.id.toLowerCase(),
          decimals: parseInt(pool.token0.decimals),
        },
      ],
      liquidityUSD: parseFloat(pool.reserveUSD),
    }));

    const pools = _.slice(
      _.sortBy(_.concat(pools0, pools1), [pool => -1 * pool.liquidityUSD]),
      0,
      count,
    );

    return pools;
  }

  protected fixPath(path: Address[], srcToken: Address, destToken: Address) {
    return path.map((token: string, i: number) => {
      if (
        (i === 0 && srcToken.toLowerCase() === ETHER_ADDRESS.toLowerCase()) ||
        (i === path.length - 1 &&
          destToken.toLowerCase() === ETHER_ADDRESS.toLowerCase())
      )
        return ETHER_ADDRESS;
      return token;
    });
  }

  getWETHAddress(srcToken: Address, destToken: Address, weth?: Address) {
    if (!isETHAddress(srcToken) && !isETHAddress(destToken))
      return NULL_ADDRESS;
    return weth || this.dexHelper.config.data.wrappedNativeTokenAddress;
  }

  getAdapterParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    toAmount: NumberAsString, // required for buy case
    data: BabydogeSwapData,
    side: SwapSide,
  ): AdapterExchangeParam {
    const payload = this.abiCoder.encodeParameter(
      {
        ParentStruct: {
          path: 'address[]',
        },
      },
      { path: data.path },
    );
    return {
      targetExchange: data.router,
      payload,
      networkFee: '0',
    };
  }

  async getSimpleParam(
    src: Address,
    dest: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    data: BabydogeSwapData,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    let swapFunction;
    let swapFunctionParams: BabydogeSwapParam = [
      side === SwapSide.SELL ? srcAmount : destAmount,
      side === SwapSide.SELL ? destAmount : srcAmount,
      data.path,
      this.augustusAddress,
      Number.MAX_SAFE_INTEGER.toString(),
    ];

    let useFeeOnTransfer = this.isFeeOnTransferSupported;

    if (side === SwapSide.SELL) {
      if (isETHAddress(src)) {
        swapFunction = useFeeOnTransfer
          ? BabydogeSwapFunctions.swapExactETHForTokensSupportingFeeOnTransferTokens
          : BabydogeSwapFunctions.swapExactETHForTokens;
        swapFunctionParams = [
          destAmount,
          data.path,
          this.augustusAddress,
          Number.MAX_SAFE_INTEGER.toString(),
        ];
      } else if (isETHAddress(dest)) {
        swapFunction = useFeeOnTransfer
          ? BabydogeSwapFunctions.swapExactTokensForETHSupportingFeeOnTransferTokens
          : BabydogeSwapFunctions.swapExactTokensForETH;
      } else {
        swapFunction = useFeeOnTransfer
          ? BabydogeSwapFunctions.swapExactTokensForTokensSupportingFeeOnTransferTokens
          : BabydogeSwapFunctions.swapExactTokensForTokens;
      }
    } else {
      if (isETHAddress(src)) {
        swapFunction = BabydogeSwapFunctions.swapETHForExactTokens;
        swapFunctionParams = [
          destAmount,
          data.path,
          this.augustusAddress,
          Number.MAX_SAFE_INTEGER.toString(),
        ];
      } else if (isETHAddress(dest)) {
        swapFunction = BabydogeSwapFunctions.swapTokensForExactETH;
      } else {
        swapFunction = BabydogeSwapFunctions.swapTokensForExactTokens;
      }
    }

    let swapData = this.exchangeRouterInterface.encodeFunctionData(
      swapFunction,
      swapFunctionParams,
    );
    return this.buildSimpleParamWithoutWETHConversion(
      src,
      srcAmount,
      dest,
      destAmount,
      swapData,
      data.router,
    );
  }
}
