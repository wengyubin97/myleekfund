/*--------------------------------------------------------------
 *  Copyright (c) Nicky<giscafer@outlook.com>. All rights reserved.
 *  Github: https://github.com/giscafer
 *-------------------------------------------------------------*/

import { window, workspace } from 'vscode';
import globalState from '../globalState';
import { clean, uniq, events } from './utils';
import { compact, flattenDeep } from 'lodash';

export class BaseConfig {
  /**
   * 获取全局（用户）配置对象
   */
  protected static getGlobalConfig() {
    return workspace.getConfiguration(undefined, null);
  }

  /**
   * 获取全局配置值（字符串数组类型）
   */
  protected static getGlobalConfigArray(key: string, defaultValue: string[] = []): string[] {
    const config = this.getGlobalConfig();
    const configInspect = config.inspect(key);
    return (configInspect?.globalValue as string[]) ?? config.get(key, defaultValue);
  }

  static getConfig(key: string, defaultValue?: any): any {
    const value = this.getGlobalConfigArray(key);
    return value === undefined ? defaultValue : value;
  }

  static setConfig(cfgKey: string, cfgValue: Array<any> | string | number | Object) {
    events.emit('updateConfig:' + cfgKey, cfgValue);
    const config = this.getGlobalConfig();
    return config.update(cfgKey, cfgValue, true);
  }

  static async updateConfig(cfgKey: string, codes: Array<string>) {
    const config = this.getGlobalConfig();
    // 优先使用全局配置值
    const origin = this.getGlobalConfigArray(cfgKey);
    let newCodes = uniq(compact(origin.concat(codes)));
    console.log(`🚀 ~ BaseConfig ~ updateConfig ~ ${cfgKey}:`, newCodes);
    await config.update(cfgKey, newCodes, true);
    return newCodes;
  }

  static removeConfig(cfgKey: string, code: string) {
    const config = this.getGlobalConfig();
    // 优先使用全局配置值
    const sourceCfg = this.getGlobalConfigArray(cfgKey);
    const newCfg = sourceCfg.filter((item: string) => item !== code);
    if (sourceCfg.length === newCfg.length) {
      window.showInformationMessage(
        `删除期货不成功。请 [点击此处](https://github.com/LeekHub/leek-fund/issues/281) 查看期货相关问题`
      );
    }
    return config.update(cfgKey, newCfg, true);
  }
}

export class LeekFundConfig extends BaseConfig {
  constructor() {
    super();
  }
  // Fund Begin
  static addFundGroupCfg(name: string, cb?: Function) {
    globalState.fundGroups.push(name);
    globalState.fundLists.push([]);
    this.setConfig('leek-fund.fundGroups', globalState.fundGroups);
    this.setConfig('leek-fund.funds', globalState.fundLists);
    window.showInformationMessage(`Fund Group Successfully add.`);
    if (cb && typeof cb === 'function') {
      cb(name);
    }
  }

  static renameFundGroupCfg(groupId: string, name: string, cb?: Function) {
    const index: number = parseInt(groupId.replace('fundGroup_', ''));
    globalState.fundGroups[index] = name;
    this.setConfig('leek-fund.fundGroups', globalState.fundGroups);
    window.showInformationMessage(`Fund Group Successfully rename.`);
    if (cb && typeof cb === 'function') {
      cb(groupId);
    }
  }

  static removeFundGroupCfg(groupId: string, cb?: Function) {
    const index: number = parseInt(groupId.replace('fundGroup_', ''));
    const removedFundList: Array<string> = globalState.fundLists[index];
    const removeFundGroup = () => {
      globalState.fundGroups.splice(index, 1);
      globalState.fundLists.splice(index, 1);
      this.setConfig('leek-fund.fundGroups', globalState.fundGroups);
      this.setConfig('leek-fund.funds', globalState.fundLists);
      window.showInformationMessage(`Fund Group Successfully delete.`);
      if (cb && typeof cb === 'function') {
        cb(groupId);
      }
    };

    if (removedFundList.length) {
      window
        .showInformationMessage('删除分组会清空基金数据无法恢复，请确认！！', '好的', '取消')
        .then((res) => {
          if (res === '好的') {
            removeFundGroup();
          }
        });
    } else {
      removeFundGroup();
    }
  }

  static addFundCfg(groupId: string, code: string, cb?: Function) {
    const index: number = parseInt(groupId.replace('fundGroup_', ''));
    const funds = globalState.fundLists[index] as Array<string | number>;
    let updatedFunds = [...funds, code];
    updatedFunds = clean(updatedFunds);
    updatedFunds = uniq(updatedFunds);
    globalState.fundLists[index] = updatedFunds as never;
    this.setConfig('leek-fund.funds', globalState.fundLists);
    window.showInformationMessage(`Fund Successfully add.`);
    if (cb && typeof cb === 'function') {
      cb(code);
    }
  }

  static removeFundCfg(code: string, cb?: Function) {
    const codeComponents = code.split('_');
    if (codeComponents.length < 3) {
      window.showInformationMessage(`Fund Id error.`);
      return;
    }
    const index: number = parseInt(codeComponents[1]);
    const fundCode: string = codeComponents[2];
    const funds = globalState.fundLists[index] as Array<string | number>;
    let updatedFunds = funds;
    updatedFunds.splice(updatedFunds.indexOf(fundCode), 1);
    updatedFunds = clean(updatedFunds);
    updatedFunds = uniq(updatedFunds);
    globalState.fundLists[index] = updatedFunds as never;
    this.setConfig('leek-fund.funds', globalState.fundLists);
    window.showInformationMessage(`Fund Successfully delete.`);
    if (cb && typeof cb === 'function') {
      cb(code);
    }
  }

  static setFundTopCfg(code: string, cb?: Function) {
    const codeComponents = code.split('_');
    if (codeComponents.length < 3) {
      window.showInformationMessage(`Fund Id error.`);
      return;
    }
    const index: number = parseInt(codeComponents[1]);
    const fundCode: string = codeComponents[2];
    const funds = globalState.fundLists[index] as Array<string>;
    const updatedFunds = [fundCode, ...funds.filter((item) => item !== fundCode)];
    globalState.fundLists[index] = updatedFunds as never;
    this.setConfig('leek-fund.funds', globalState.fundLists);
    window.showInformationMessage(`Fund Successfully set to top.`);
    if (cb && typeof cb === 'function') {
      cb(code);
    }
  }
  // Fund End

  // Stock Begin
  /**
   * 解析股票 id，兼容自定义分组内的股票 id 格式：stockGroup_{index}_{code}
   */
  static parseStockCode(id: string): string {
    if (!id) return id;
    const match = /^stockGroup_\d+_(.+)$/.exec(id);
    return match ? match[1] : id;
  }

  static addStockGroupCfg(name: string, cb?: Function) {
    globalState.stockGroups.push(name);
    globalState.stockGroupStocks.push([]);
    this.setConfig('leek-fund.stockGroups', globalState.stockGroups);
    this.setConfig('leek-fund.stockGroupStocks', globalState.stockGroupStocks);
    window.showInformationMessage(`Stock Group Successfully add.`);
    if (cb && typeof cb === 'function') {
      cb(name);
    }
  }

  static renameStockGroupCfg(groupId: string, name: string, cb?: Function) {
    const index: number = parseInt(groupId.replace('stockGroup_', ''));
    globalState.stockGroups[index] = name;
    this.setConfig('leek-fund.stockGroups', globalState.stockGroups);
    window.showInformationMessage(`Stock Group Successfully rename.`);
    if (cb && typeof cb === 'function') {
      cb(groupId);
    }
  }

  static removeStockGroupCfg(groupId: string, cb?: Function) {
    const index: number = parseInt(groupId.replace('stockGroup_', ''));
    const removedStocks: Array<string> = globalState.stockGroupStocks[index] || [];
    const removeStockGroup = () => {
      globalState.stockGroups.splice(index, 1);
      globalState.stockGroupStocks.splice(index, 1);
      this.setConfig('leek-fund.stockGroups', globalState.stockGroups);
      this.setConfig('leek-fund.stockGroupStocks', globalState.stockGroupStocks);
      window.showInformationMessage(`Stock Group Successfully delete.`);
      if (cb && typeof cb === 'function') {
        cb(groupId);
      }
    };

    if (removedStocks.length) {
      window
        .showInformationMessage('删除分组不会删除自选股，仅移除分组关系，确认删除？', '好的', '取消')
        .then((res) => {
          if (res === '好的') {
            removeStockGroup();
          }
        });
    } else {
      removeStockGroup();
    }
  }

  static addStockToGroupCfg(groupId: string, code: string, cb?: Function) {
    const index: number = parseInt(groupId.replace('stockGroup_', ''));
    const stocks = globalState.stockGroupStocks[index] as Array<string>;
    let updatedStocks = [...(stocks || []), code];
    updatedStocks = clean(updatedStocks) as Array<string>;
    updatedStocks = uniq(updatedStocks) as Array<string>;
    globalState.stockGroupStocks[index] = updatedStocks as never;
    this.setConfig('leek-fund.stockGroupStocks', globalState.stockGroupStocks);
    // 确保股票在自选列表中，才能拉取数据
    const allStocks = this.getConfig('leek-fund.stocks') || [];
    if (!allStocks.includes(code)) {
      this.updateConfig('leek-fund.stocks', [code]);
    }
    window.showInformationMessage(`Stock Successfully added to group.`);
    if (cb && typeof cb === 'function') {
      cb(code);
    }
  }

  static removeStockFromGroupCfg(id: string, cb?: Function) {
    const match = /^stockGroup_(\d+)_(.+)$/.exec(id || '');
    if (!match) {
      return;
    }
    const index: number = parseInt(match[1]);
    const code: string = match[2];
    const stocks = globalState.stockGroupStocks[index] as Array<string>;
    const updatedStocks = (stocks || []).filter((item) => item !== code);
    globalState.stockGroupStocks[index] = updatedStocks as never;
    this.setConfig('leek-fund.stockGroupStocks', globalState.stockGroupStocks);
    window.showInformationMessage(`Stock Successfully removed from group.`);
    if (cb && typeof cb === 'function') {
      cb(id);
    }
  }

  static updateStockCfg(list: string, cb?: Function) {
    const cfgKey = 'leek-fund.stocks';
    const config = this.getGlobalConfig();
    // 优先使用全局配置值
    const origin = this.getGlobalConfigArray(cfgKey);
    let codes = typeof list === 'string' ? list.split(',') : list;
    let newCodes = uniq(compact(flattenDeep(origin).concat(codes))) as string[];
    newCodes = newCodes.map((code: string) => {
      if (code.startsWith('hk')) {
        return code.toLowerCase();
      }
      return code;
    });
    config.update(cfgKey, newCodes, true).then(() => {
      window.showInformationMessage(`Stock Successfully add.`);
      if (cb && typeof cb === 'function') {
        cb(codes, newCodes);
      }
    });
  }

  static removeStockCfg(code: string, cb?: Function) {
    this.removeConfig('leek-fund.stocks', this.parseStockCode(code)).then(() => {
      window.showInformationMessage(`Stock Successfully delete.`);
      if (cb && typeof cb === 'function') {
        cb(code);
      }
    });
  }

  static addStockToBarCfg(code: string, cb?: Function) {
    const addStockToBar = () => {
      const stockCode = this.parseStockCode(code);
      let configArr: string[] = this.getConfig('leek-fund.statusBarStock');
      if (configArr.includes(stockCode)) {
        window.showInformationMessage(`StatusBar Already Have.`);
        if (cb && typeof cb === 'function') {
          cb(code);
        }
      } else {
        configArr.push(stockCode);
        this.setConfig('leek-fund.statusBarStock', configArr).then(() => {
          window.showInformationMessage(`Stock Successfully add to statusBar.`);
          if (cb && typeof cb === 'function') {
            cb(code);
          }
        });
      }
    };

    if (this.getConfig('leek-fund.hideStatusBarStock')) {
      this.setConfig('leek-fund.hideStatusBarStock', false).then(() => {
        addStockToBar();
      });
    } else {
      addStockToBar();
    }
  }

  static setStockTopCfg(code: string, cb?: Function) {
    let arr: string[] = this.getConfig('leek-fund.stocks');
    const stockCode = this.parseStockCode(code);
    // 临时解决3.10.1~3.10.3 pr产生的分组bug
    const stockList = flattenDeep(arr).filter?.((item) => item !== stockCode);
    stockList.unshift(stockCode);

    this.setConfig('leek-fund.stocks', stockList).then(() => {
      window.showInformationMessage(`Stock successfully set to top.`);
      if (cb && typeof cb === 'function') {
        cb(code);
      }
    });
  }

  static setStockUpCfg(code: string, cb?: Function) {
    const stockCode = this.parseStockCode(code);
    const callback = () => {
      window.showInformationMessage(`Stock successfully move up.`);
      if (cb && typeof cb === 'function') {
        cb(code);
      }
    };

    let configArr: string[] = this.getConfig('leek-fund.stocks');
    const currentIndex = configArr.indexOf(stockCode);
    let previousIndex = currentIndex - 1;
    // 找到前一个同市场的股票
    for (let index = currentIndex - 1; index >= 0; index--) {
      const previousCode = configArr[index];
      if (/^(sh|sz|bj)/.test(stockCode) && /^(sh|sz|bj)/.test(previousCode)) {
        previousIndex = index;
        break;
      }
      if (/^(hk)/.test(stockCode) && /^(hk)/.test(previousCode)) {
        previousIndex = index;
        break;
      }
      if (/^(usr_)/.test(stockCode) && /^(usr_)/.test(previousCode)) {
        previousIndex = index;
        break;
      }
      if (/^(nf_)/.test(stockCode) && /^(nf_)/.test(previousCode)) {
        previousIndex = index;
        break;
      }
      if (/^(hf_)/.test(stockCode) && /^(hf_)/.test(previousCode)) {
        previousIndex = index;
        break;
      }
    }
    if (previousIndex < 0) {
      callback();
    } else {
      // 交换位置
      configArr[currentIndex] = configArr.splice(previousIndex, 1, configArr[currentIndex])[0];
      this.setConfig('leek-fund.stocks', configArr).then(() => {
        callback();
      });
    }
  }

  static setStockDownCfg(code: string, cb?: Function) {
    const stockCode = this.parseStockCode(code);
    const callback = () => {
      window.showInformationMessage(`Stock successfully move down.`);
      if (cb && typeof cb === 'function') {
        cb(code);
      }
    };

    let configArr: string[] = this.getConfig('leek-fund.stocks');
    const currentIndex = configArr.indexOf(stockCode);
    let nextIndex = currentIndex + 1;
    //找到后一个同市场的股票
    for (let index = currentIndex + 1; index < configArr.length; index++) {
      const nextCode = configArr[index];
      if (/^(sh|sz|bj)/.test(stockCode) && /^(sh|sz|bj)/.test(nextCode)) {
        nextIndex = index;
        break;
      }
      if (/^(hk)/.test(stockCode) && /^(hk)/.test(nextCode)) {
        nextIndex = index;
        break;
      }
      if (/^(usr_)/.test(stockCode) && /^(usr_)/.test(nextCode)) {
        nextIndex = index;
        break;
      }
      if (/^(nf_)/.test(stockCode) && /^(nf_)/.test(nextCode)) {
        nextIndex = index;
        break;
      }
      if (/^(hf_)/.test(stockCode) && /^(hf_)/.test(nextCode)) {
        nextIndex = index;
        break;
      }
    }
    if (nextIndex >= configArr.length) {
      callback();
    } else {
      // 交换位置
      configArr[currentIndex] = configArr.splice(nextIndex, 1, configArr[currentIndex])[0];
      this.setConfig('leek-fund.stocks', configArr).then(() => {
        callback();
      });
    }
  }

  // Stock End

  // Binance Begin
  static updateBinanceCfg(codes: string, cb?: Function) {
    this.updateConfig('leek-fund.binance', codes.split(',')).then(() => {
      window.showInformationMessage(`Pair Successfully add.`);
      if (cb && typeof cb === 'function') {
        cb(codes);
      }
    });
  }
  static removeBinanceCfg(code: string, cb?: Function) {
    this.removeConfig('leek-fund.binance', code).then(() => {
      window.showInformationMessage(`Pair Successfully delete.`);
      if (cb && typeof cb === 'function') {
        cb(code);
      }
    });
  }
  static setBinanceTopCfg(code: string, cb?: Function) {
    let configArr: string[] = this.getConfig('leek-fund.binance');
    configArr = [code, ...configArr.filter((item) => item !== code)];
    this.setConfig('leek-fund.binance', configArr).then(() => {
      window.showInformationMessage(`Pair successfully set to top.`);
      if (cb && typeof cb === 'function') {
        cb(code);
      }
    });
  }
  // Binance end

  // StatusBar Begin
  static updateStatusBarStockCfg(codes: Array<string>, cb?: Function) {
    const updateStatusBarStock = () => {
      this.setConfig('leek-fund.statusBarStock', codes).then(() => {
        window.showInformationMessage(`Status Bar Stock Successfully update.`);
        if (cb && typeof cb === 'function') {
          cb(codes);
        }
      });
    };

    if (codes.length) {
      if (this.getConfig('leek-fund.hideStatusBarStock')) {
        this.setConfig('leek-fund.hideStatusBarStock', false).then(() => {
          updateStatusBarStock();
        });
      } else {
        updateStatusBarStock();
      }
    } else {
      if (!this.getConfig('leek-fund.hideStatusBarStock')) {
        this.setConfig('leek-fund.hideStatusBarStock', true).then(() => {
          updateStatusBarStock();
        });
      } else {
        updateStatusBarStock();
      }
    }
  }
  static addStockGroupToBarCfg(name: string, cb?: Function) {
    const addStockGroupToBar = () => {
      let configArr: string[] = this.getConfig('leek-fund.statusBarStockGroups');
      // 清理已删除分组的残留配置，避免占用状态栏
      configArr = configArr.filter((groupName) => globalState.stockGroups.includes(groupName));
      if (configArr.includes(name)) {
        window.showInformationMessage(`StatusBar Already Have.`);
        if (cb && typeof cb === 'function') {
          cb(name);
        }
      } else {
        configArr.push(name);
        this.setConfig('leek-fund.statusBarStockGroups', configArr).then(() => {
          window.showInformationMessage(`Stock Group Successfully add to statusBar.`);
          if (cb && typeof cb === 'function') {
            cb(name);
          }
        });
      }
    };

    if (this.getConfig('leek-fund.hideStatusBarStock')) {
      this.setConfig('leek-fund.hideStatusBarStock', false).then(() => {
        addStockGroupToBar();
      });
    } else {
      addStockGroupToBar();
    }
  }

  static updateStatusBarStockGroupCfg(names: Array<string>, cb?: Function) {
    this.setConfig('leek-fund.statusBarStockGroups', names).then(() => {
      window.showInformationMessage(`Status Bar Stock Group Successfully update.`);
      if (cb && typeof cb === 'function') {
        cb(names);
      }
    });
  }
  // StatusBar End
}
