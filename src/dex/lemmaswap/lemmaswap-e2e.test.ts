import dotenv from 'dotenv';
dotenv.config();

import { testE2E } from '../../../tests/utils-e2e';
import {
  Tokens,
  Holders,
  NativeTokenSymbols,
} from '../../../tests/constants-e2e';
import { Network, ContractMethod, SwapSide } from '../../constants';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { generateConfig } from '../../config';

/*
  README
  ======

  This test script should add e2e tests for Lemmaswap. The tests
  should cover as many cases as possible. Most of the DEXes follow
  the following test structure:
    - DexName
      - ForkName + Network
        - ContractMethod
          - ETH -> Token swap
          - Token -> ETH swap
          - Token -> Token swap

  The template already enumerates the basic structure which involves
  testing simpleSwap, multiSwap, megaSwap contract methods for
  ETH <> TOKEN and TOKEN <> TOKEN swaps. You should replace tokenA and
  tokenB with any two highly liquid tokens on Lemmaswap for the tests
  to work. If the tokens that you would like to use are not defined in
  Tokens or Holders map, you can update the './tests/constants-e2e'

  Other than the standard cases that are already added by the template
  it is highly recommended to add test cases which could be specific
  to testing Lemmaswap (Eg. Tests based on poolType, special tokens,
  etc).

  You can run this individual test script by running:
  `npx jest src/dex/<dex-name>/<dex-name>-e2e.test.ts`

  e2e tests use the Tenderly fork api. Please add the following to your
  .env file:
  TENDERLY_TOKEN=Find this under Account>Settings>Authorization.
  TENDERLY_ACCOUNT_ID=Your Tenderly account name.
  TENDERLY_PROJECT=Name of a Tenderly project you have created in your
  dashboard.

  (This comment should be removed from the final implementation)
*/

// function testForNetwork(
//   network: Network,
//   dexKey: string,
//   tokenASymbol: string,
//   tokenBSymbol: string,
//   tokenAAmount: string,
//   tokenBAmount: string,
//   nativeTokenAmount: string,
// ) {
//   const provider = new StaticJsonRpcProvider(
//     generateConfig(network).privateHttpProvider,
//     network,
//   );
//   const tokens = Tokens[network];
//   const holders = Holders[network];
//   const nativeTokenSymbol = NativeTokenSymbols[network];

//   // TODO: Add any direct swap contractMethod name if it exists
//   const sideToContractMethods = new Map([
//     [
//       SwapSide.SELL,
//       [
//         ContractMethod.simpleSwap,
//         ContractMethod.multiSwap,
//         ContractMethod.megaSwap,
//       ],
//     ],
//     // TODO: If buy is not supported remove the buy contract methods
//     [SwapSide.BUY, [ContractMethod.simpleBuy, ContractMethod.buy]],
//   ]);

//   describe(`${network}`, () => {
//     sideToContractMethods.forEach((contractMethods, side) =>
//       describe(`${side}`, () => {
//         contractMethods.forEach((contractMethod: ContractMethod) => {
//           describe(`${contractMethod}`, () => {
//             it(`${nativeTokenSymbol} -> ${tokenASymbol}`, async () => {
//               await testE2E(
//                 tokens[nativeTokenSymbol],
//                 tokens[tokenASymbol],
//                 holders[nativeTokenSymbol],
//                 side === SwapSide.SELL ? nativeTokenAmount : tokenAAmount,
//                 side,
//                 dexKey,
//                 contractMethod,
//                 network,
//                 provider,
//               );
//             });
//             it(`${tokenASymbol} -> ${nativeTokenSymbol}`, async () => {
//               await testE2E(
//                 tokens[tokenASymbol],
//                 tokens[nativeTokenSymbol],
//                 holders[tokenASymbol],
//                 side === SwapSide.SELL ? tokenAAmount : nativeTokenAmount,
//                 side,
//                 dexKey,
//                 contractMethod,
//                 network,
//                 provider,
//               );
//             });
//             it(`${tokenASymbol} -> ${tokenBSymbol}`, async () => {
//               await testE2E(
//                 tokens[tokenASymbol],
//                 tokens[tokenBSymbol],
//                 holders[tokenASymbol],
//                 side === SwapSide.SELL ? tokenAAmount : tokenBAmount,
//                 side,
//                 dexKey,
//                 contractMethod,
//                 network,
//                 provider,
//               );
//             });
//           });
//         });
//       }),
//     );
//   });
// }

describe('Lemmaswap E2E', () => {
  const dexKey = 'Lemmaswap';

  describe('Optimism', () => {
    const network = Network.OPTIMISM;

    // TODO: Modify the tokenASymbol, tokenBSymbol, tokenAAmount;
    const nativeTokenSymbol: string = 'ETH';
    const tokenASymbol: string = 'WETH';
    const tokenBSymbol: string = 'USDC';

    const ethAmount = '1000000000000000';
    const usdcAmount = '10000000';

    const tokens = Tokens[network];
    const holders = Holders[network];
    const provider = new StaticJsonRpcProvider(
      generateConfig(network).privateHttpProvider,
      network,
    );
    const nativeToken = tokens[nativeTokenSymbol];
    const wethToken = tokens[tokenASymbol];
    const usdcToken = tokens[tokenBSymbol];

    const ethHolder = holders[nativeTokenSymbol];
    const usdcHolder = holders[tokenBSymbol];
    const wethHolder = '0xD9a1Ed9AAC149bf9bD655F9b9DdECF9bD04316b3';

    // testForNetwork(
    //   network,
    //   dexKey,
    //   tokenASymbol,
    //   tokenBSymbol,
    //   tokenAAmount,
    //   tokenBAmount,
    //   nativeTokenAmount,
    // );

    // TODO: Add any additional test cases required to test Lemmaswap

    describe('SimpleSwap SELL', () => {
      const contractMethod = ContractMethod.simpleSwap;
      const side = SwapSide.SELL;

      it('ETH -> USDC', async () => {
        await testE2E(
          nativeToken,
          usdcToken,
          ethHolder,
          ethAmount,
          side,
          dexKey,
          contractMethod,
          network,
          provider,
        );
      });

      it('USDC -> ETH', async () => {
        await testE2E(
          usdcToken,
          nativeToken,
          usdcHolder,
          usdcAmount,
          side,
          dexKey,
          contractMethod,
          network,
          provider,
        );
      });

      it('WETH -> USDC', async () => {
        await testE2E(
          wethToken,
          usdcToken,
          wethHolder,
          ethAmount,
          side,
          dexKey,
          contractMethod,
          network,
          provider,
        );
      });

      it('USDC -> WETH', async () => {
        await testE2E(
          usdcToken,
          wethToken,
          usdcHolder,
          usdcAmount,
          side,
          dexKey,
          contractMethod,
          network,
          provider,
        );
      });
    });
  });
});
