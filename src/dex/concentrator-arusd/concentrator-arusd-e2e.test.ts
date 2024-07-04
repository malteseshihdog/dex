/* eslint-disable no-console */
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

function testForNetwork(
  network: Network,
  dexKey: string,
  tokenASymbol: string,
  tokenBSymbol: string,
  tokenAAmount: string,
  tokenBAmount: string,
  nativeTokenAmount: string,
) {
  const provider = new StaticJsonRpcProvider(
    generateConfig(network).privateHttpProvider,
    network,
  );
  const tokens = Tokens[network];
  const holders = Holders[network];

  const sideToContractMethods = new Map([
    [SwapSide.SELL, [ContractMethod.swapExactAmountIn]],
  ]);

  describe(`${network}`, () => {
    sideToContractMethods.forEach((contractMethods, side) =>
      describe(`${side}`, () => {
        contractMethods.forEach((contractMethod: ContractMethod) => {
          describe(`${contractMethod}`, () => {
            it(`${tokenASymbol} -> ${tokenBSymbol}`, async () => {
              await testE2E(
                tokens[tokenASymbol],
                tokens[tokenBSymbol],
                holders[tokenASymbol],
                side === SwapSide.SELL ? tokenAAmount : tokenBAmount,
                side,
                dexKey,
                contractMethod,
                network,
                provider,
              );
            });
          });
        });
      }),
    );
  });
}

describe('ConcentratorArusd E2E', () => {
  const dexKey = 'ConcentratorArusd';
  const network = Network.MAINNET;

  const tokenASymbol: string = 'rUSD';
  const tokenBSymbol: string = 'arUSD';

  const tokenAAmount: string = '1000000000000000000';
  const tokenBAmount: string = '1000000000000000000';
  const nativeTokenAmount = '1000000000000000000';
  describe('Mainnet rUSD=>arUSD', () => {
    testForNetwork(
      network,
      dexKey,
      tokenASymbol,
      tokenBSymbol,
      tokenAAmount,
      tokenBAmount,
      nativeTokenAmount,
    );
  });

  describe('Mainnet arUSD=>rUSD', () => {
    testForNetwork(
      network,
      dexKey,
      tokenBSymbol,
      tokenASymbol,
      tokenBAmount,
      tokenAAmount,
      nativeTokenAmount,
    );
  });

  describe('Mainnet arUSD=>weETH', () => {
    testForNetwork(
      network,
      dexKey,
      tokenBSymbol,
      tokenASymbol,
      tokenBAmount,
      tokenAAmount,
      nativeTokenAmount,
    );
  });
});
