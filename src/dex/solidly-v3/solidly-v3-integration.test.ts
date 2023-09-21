/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import { Interface, Result } from '@ethersproject/abi';
import {DummyDexHelper, IDexHelper} from '../../dex-helper/index';
import { Network, SwapSide } from '../../constants';
import { BI_POWS } from '../../bigint-constants';
import { SolidlyV3 } from './solidly-v3';
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "./constants";
import {
  checkPoolPrices,
  checkPoolsLiquidity,
  checkConstantPoolPrices,
} from '../../../tests/utils';
import { Tokens } from '../../../tests/constants-e2e';
import {Address} from "@paraswap/core";
import SolidlyV3PoolABI from '../../abi/solidly-v3/SolidlyV3Pool.abi.json';

/*
  README
  ======

  This test script adds tests for SolidlyV3 general integration
  with the DEX interface. The test cases below are example tests.
  It is recommended to add tests which cover SolidlyV3 specific
  logic.

  You can run this individual test script by running:
  `npx jest src/dex/<dex-name>/<dex-name>-integration.test.ts`

  (This comment should be removed from the final implementation)
*/

const network = Network.MAINNET;
const dexHelper = new DummyDexHelper(network);

const WETH = Tokens[network]['WETH'];
const USDT = Tokens[network]['USDT'];

const amounts = [0n, 1n * BI_POWS[18], 2n * BI_POWS[18]];

function getReaderCalldata(
  exchangeAddress: string,
  readerIface: Interface,
  amounts: bigint[],
  funcName: string,
  zeroForOne: boolean,
  sqrtPriceLimitX96: bigint,
) {
  return amounts.map(amount => ({
    target: exchangeAddress,
    callData: readerIface.encodeFunctionData(funcName, [zeroForOne, amount.toString(), sqrtPriceLimitX96.toString()]),
  }));
}

function decodeReaderResult(
  results: Result,
  readerIface: Interface,
  funcName: string,
) {
  // TODO: Adapt this function for your needs
  return results.map(result => {
    const parsed = readerIface.decodeFunctionResult(funcName, result);
    return parsed[1]._hex[0] == '-' ? BigInt(parsed[1]._hex.slice(1)) : BigInt(parsed[1]._hex);
  });
}

async function checkOnChainPricing(
  dexHelper: IDexHelper,
  blockNumber: number,
  poolAddress: string,
  prices: bigint[],
  tokenIn: Address,
  tokenOut: Address,
  tickSpacing: bigint,
  _amounts: bigint[],
) {
  // Quoter address
  // const exchangeAddress = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6';
  const readerIface = new Interface(SolidlyV3PoolABI);

  const sum = prices.reduce((acc, curr) => (acc += curr), 0n);

  if (sum === 0n) {
    console.log(
      `Prices were not calculated for tokenIn=${tokenIn}, tokenOut=${tokenOut}, tickSpacing=${tickSpacing.toString()}. Most likely price impact is too big for requested amount`,
    );
    return false;
  }

  const readerCallData = getReaderCalldata(
    poolAddress,
    readerIface,
    _amounts.slice(1),
    'quoteSwap',
    true,
    MIN_SQRT_RATIO + BigInt(1),
  );

  let readerResult;
  try {
    readerResult = (
      await dexHelper.multiContract.methods
        .aggregate(readerCallData)
        .call({}, blockNumber)
    ).returnData;
  } catch (e) {
    console.log(
      `Can not fetch on-chain pricing for tickSpacing ${tickSpacing}. It happens for low liquidity pools`,
      e,
    );
    return false;
  }

  const expectedPrices = [0n].concat(
    decodeReaderResult(readerResult, readerIface, 'quoteSwap'),
  );

  console.log('EXPECTED PRICES: ', expectedPrices);

  let firstZeroIndex = prices.slice(1).indexOf(0n);

  // we skipped first, so add +1 on result
  firstZeroIndex = firstZeroIndex === -1 ? prices.length : firstZeroIndex;

  // Compare only the ones for which we were able to calculate prices
  expect(prices.slice(0, firstZeroIndex)).toEqual(
    expectedPrices.slice(0, firstZeroIndex),
  );
  return true;
}

async function testPricingOnNetwork(
  solidlyV3: SolidlyV3,
  network: Network,
  dexKey: string,
  blockNumber: number,
  srcTokenSymbol: string,
  destTokenSymbol: string,
  side: SwapSide,
  amounts: bigint[],
  funcNameToCheck: string,
) {
  const networkTokens = Tokens[network];

  const pools = await solidlyV3.getPoolIdentifiers(
    networkTokens[srcTokenSymbol],
    networkTokens[destTokenSymbol],
    side,
    blockNumber,
  );
  console.log(
    `${srcTokenSymbol} <> ${destTokenSymbol} Pool Identifiers: `,
    pools,
  );

  expect(pools.length).toBeGreaterThan(0);

  const poolPrices = await solidlyV3.getPricesVolume(
    networkTokens[srcTokenSymbol],
    networkTokens[destTokenSymbol],
    amounts,
    side,
    blockNumber,
    pools,
  );
  console.log(
    `${srcTokenSymbol} <> ${destTokenSymbol} Pool Prices: `,
    poolPrices,
  );

  expect(poolPrices).not.toBeNull();
  if (solidlyV3.hasConstantPriceLargeAmounts) {
    checkConstantPoolPrices(poolPrices!, amounts, dexKey);
  } else {
    checkPoolPrices(poolPrices!, amounts, side, dexKey);
  }

  // Check if onchain pricing equals to calculated ones
  // await checkOnChainPricing(
  //   solidlyV3,
  //   funcNameToCheck,
  //   blockNumber,
  //   poolPrices![0].prices,
  //   amounts,
  // );
}

describe('SolidlyV3', function () {
  const dexKey = 'SolidlyV3';
  let blockNumber: number;
  let solidlyV3: SolidlyV3;

  beforeEach(async () => {
    blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
    const solidlyV3 = new SolidlyV3(network, dexKey, dexHelper);
  });

  describe('Mainnet', () => {
    const network = Network.MAINNET;
    const dexHelper = new DummyDexHelper(network);

    const tokens = Tokens[network];

    // TODO: Put here token Symbol to check against
    // Don't forget to update relevant tokens in constant-e2e.ts
    const srcTokenSymbol = 'WETH';
    const destTokenSymbol = 'USDT';

    const amountsForSell = [
      0n,
      1n * BI_POWS[tokens[srcTokenSymbol].decimals],
      2n * BI_POWS[tokens[srcTokenSymbol].decimals],
      3n * BI_POWS[tokens[srcTokenSymbol].decimals],
      4n * BI_POWS[tokens[srcTokenSymbol].decimals],
      5n * BI_POWS[tokens[srcTokenSymbol].decimals],
      6n * BI_POWS[tokens[srcTokenSymbol].decimals],
      7n * BI_POWS[tokens[srcTokenSymbol].decimals],
      8n * BI_POWS[tokens[srcTokenSymbol].decimals],
      9n * BI_POWS[tokens[srcTokenSymbol].decimals],
      10n * BI_POWS[tokens[srcTokenSymbol].decimals],
    ];

    const amountsForBuy = [
      0n,
      1n * BI_POWS[tokens[destTokenSymbol].decimals],
      2n * BI_POWS[tokens[destTokenSymbol].decimals],
      3n * BI_POWS[tokens[destTokenSymbol].decimals],
      4n * BI_POWS[tokens[destTokenSymbol].decimals],
      5n * BI_POWS[tokens[destTokenSymbol].decimals],
      6n * BI_POWS[tokens[destTokenSymbol].decimals],
      7n * BI_POWS[tokens[destTokenSymbol].decimals],
      8n * BI_POWS[tokens[destTokenSymbol].decimals],
      9n * BI_POWS[tokens[destTokenSymbol].decimals],
      10n * BI_POWS[tokens[destTokenSymbol].decimals],
    ];

    beforeAll(async () => {
      blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
      solidlyV3 = new SolidlyV3(network, dexKey, dexHelper);
      if (solidlyV3.initializePricing) {
        await solidlyV3.initializePricing(blockNumber);
      }
    });

    it('base case', async function () {
      console.log('base case');
    });

    it('WETH -> USDT getPoolIdentifiers and getPricesVolume SELL', async function () {

      const pools = await solidlyV3.getPoolIdentifiers(
        WETH,
        USDT,
        SwapSide.SELL,
        blockNumber,
      );
      console.log(`WETH <> USDT Pool Identifiers: `, pools);

      expect(pools.length).toBeGreaterThan(0);

      const poolPrices = await solidlyV3.getPricesVolume(
        WETH,
        USDT,
        amounts,
        SwapSide.SELL,
        blockNumber,
        pools,
      );
      console.log(`WETH <> USDT Pool Prices: `, poolPrices);

      expect(poolPrices).not.toBeNull();
      checkPoolPrices(poolPrices!, amounts, SwapSide.SELL, dexKey);

      let falseChecksCounter = 0;
      await Promise.all(
        poolPrices!.map(async price => {
          const tickSpacing = solidlyV3.eventPools[price.poolIdentifier!]!.tickSpacing;
          const res = await checkOnChainPricing(
            dexHelper,
            blockNumber,
            solidlyV3.eventPools[price.poolIdentifier!]!.poolAddress,
            price.prices,
            WETH.address,
            USDT.address,
            tickSpacing,
            amounts,
          );
          if (res === false) falseChecksCounter++;
        }),
      );

      expect(falseChecksCounter).toBeLessThan(poolPrices!.length);
    });

    it('getPoolIdentifiers and getPricesVolume SELL', async function () {
      await testPricingOnNetwork(
        solidlyV3,
        network,
        dexKey,
        blockNumber,
        srcTokenSymbol,
        destTokenSymbol,
        SwapSide.SELL,
        amountsForSell,
        '', // TODO: Put here proper function name to check pricing
      );
    });

    it('getPoolIdentifiers and getPricesVolume BUY', async function () {
      await testPricingOnNetwork(
        solidlyV3,
        network,
        dexKey,
        blockNumber,
        srcTokenSymbol,
        destTokenSymbol,
        SwapSide.BUY,
        amountsForBuy,
        '', // TODO: Put here proper function name to check pricing
      );
    });

    it('getTopPoolsForToken', async function () {
      // We have to check without calling initializePricing, because
      // pool-tracker is not calling that function
      const newSolidlyV3 = new SolidlyV3(network, dexKey, dexHelper);
      // if (newSolidlyV3.updatePoolState) {
      //   await newSolidlyV3.updatePoolState();
      // }
      const poolLiquidity = await newSolidlyV3.getTopPoolsForToken(
        tokens[srcTokenSymbol].address,
        10,
      );
      console.log(`${srcTokenSymbol} Top Pools:`, poolLiquidity);

      if (!newSolidlyV3.hasConstantPriceLargeAmounts) {
        checkPoolsLiquidity(
          poolLiquidity,
          Tokens[network][srcTokenSymbol].address,
          dexKey,
        );
      }
    });
  });
});