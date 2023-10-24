import { Solidly } from '../solidly';
import { SolidlyPair } from '../types';
import { Network } from '../../../constants';
import { IDexHelper } from '../../../dex-helper';
import { Interface } from '@ethersproject/abi';
import { getDexKeysWithNetwork } from '../../../utils';
import { SolidlyConfig } from '../config';
import _ from 'lodash';

const velocimeterFactoryABI = [
  {
    inputs: [{ internalType: '_pair', name: '_stable', type: 'address' }],
    name: 'getFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const velocimeteractoryIface = new Interface(velocimeterFactoryABI);

export class Velocimeter extends Solidly {
  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(_.pick(SolidlyConfig, ['Velocimeter']));

  constructor(
    protected network: Network,
    dexKey: string,
    protected dexHelper: IDexHelper,
  ) {
    super(
      network,
      dexKey,
      dexHelper,
      true, // dynamic fees
    );
  }

  protected getFeesMultiCallData(pair: SolidlyPair) {
    const callEntry = {
      target: this.factoryAddress,
      callData: velocimeteractoryIface.encodeFunctionData('getFee', [pair.exchange]),
    };
    const callDecoder = (values: any[]) =>
      parseInt(
        velocimeteractoryIface.decodeFunctionResult('getFee', values)[0].toString(),
      );

    return {
      callEntry,
      callDecoder,
    };
  }
}