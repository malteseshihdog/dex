import { Network } from '../../../constants';
import { getDexKeysWithNetwork } from '../../../utils';
import { InfusionFinanceConfig } from '../config';
import _ from 'lodash';
import { Ramses } from './ramses';

export class PharaohV1 extends Ramses {
  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(_.pick(InfusionFinanceConfig, ['PharaohV1']));
}
