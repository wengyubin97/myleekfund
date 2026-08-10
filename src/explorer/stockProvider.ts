import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
// import { compact, flattenDeep, uniq } from 'lodash';
import globalState from '../globalState';
import { LeekTreeItem } from '../shared/leekTreeItem';
import { defaultFundInfo, SortType, StockCategory } from '../shared/typed';
import { LeekFundConfig } from '../shared/leekConfig';
import { calcStockGroupAvgPercent } from '../shared/utils';
import { enrichStockTooltips } from '../statusbar/groupChart';
import StockService from './stockService';

export class StockProvider implements TreeDataProvider<LeekTreeItem> {
  private _onDidChangeTreeData: EventEmitter<any> = new EventEmitter<any>();

  readonly onDidChangeTreeData: Event<any> = this._onDidChangeTreeData.event;

  private service: StockService;
  private order: SortType;
  private expandAStock: boolean;
  private expandHKStock: boolean;
  private expandUSStock: boolean;
  private expandCNFuture: boolean;
  private expandOverseaFuture: boolean;

  constructor(service: StockService) {
    this.service = service;
    this.order = LeekFundConfig.getConfig('leek-fund.stockSort') || SortType.NORMAL;
    this.expandAStock = LeekFundConfig.getConfig('leek-fund.expandAStock', true);
    this.expandHKStock = LeekFundConfig.getConfig('leek-fund.expandHKStock', false);
    this.expandUSStock = LeekFundConfig.getConfig('leek-fund.expandUSStock', false);
    this.expandCNFuture = LeekFundConfig.getConfig('leek-fund.expandCNFuture', false);
    this.expandOverseaFuture = LeekFundConfig.getConfig('leek-fund.expandOverseaFuture', false);
  }

  refresh(): any {
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(element?: LeekTreeItem | undefined): LeekTreeItem[] | Thenable<LeekTreeItem[]> {
    if (!element) {
      // Root view
      const stockCodes = LeekFundConfig.getConfig('leek-fund.stocks') || [];
      // const stockList: string[] = uniq(compact(flattenDeep(stockCodes)));
      return this.service.getData(stockCodes, this.order).then(() => {
        // 异步给树节点 tooltip 追加分时图
        enrichStockTooltips(this.service.stockList);
        return this.getRootNodes();
      });
    } else {
      const resultPromise = Promise.resolve(this.service.stockList || []);
      switch (
        element.id // First-level
      ) {
        case StockCategory.A:
          return this.getAStockNodes(resultPromise);
        case StockCategory.HK:
          return this.getHkStockNodes(resultPromise);
        case StockCategory.US:
          return this.getUsStockNodes(resultPromise);
        case StockCategory.Future:
          return this.getFutureStockNodes(resultPromise);
        case StockCategory.OverseaFuture:
          return this.getOverseaFutureStockNodes(resultPromise);
        case StockCategory.NODATA:
          return this.getNoDataStockNodes(resultPromise);
        default:
          if (element.id && element.id.startsWith('stockGroup_')) {
            return this.getStockGroupNodes(element.id);
          }
          return [];
        // return this.getChildrenNodesById(element.id);
      }
    }
  }

  getParent(): LeekTreeItem | undefined {
    return undefined;
  }

  getTreeItem(element: LeekTreeItem): TreeItem {
    if (!element.isCategory) {
      return element;
    } else {
      return {
        id: element.id,
        label: element.info.name,
        // tooltip: this.getSubCategoryTooltip(element),
        collapsibleState:
          (element.id === StockCategory.A && this.expandAStock) ||
          (element.id === StockCategory.HK && this.expandHKStock) ||
          (element.id === StockCategory.US && this.expandUSStock) ||
          (element.id === StockCategory.Future && this.expandCNFuture) ||
          (element.id === StockCategory.OverseaFuture && this.expandCNFuture) ||
          (element.id && element.id.startsWith('stockGroup_'))
            ? TreeItemCollapsibleState.Expanded
            : TreeItemCollapsibleState.Collapsed,
        // iconPath: this.parseIconPathFromProblemState(element),
        command: undefined,
        contextValue: element.contextValue,
      };
    }
  }

  getRootNodes(): LeekTreeItem[] {
    const nodes = [
      new LeekTreeItem(
        Object.assign({ contextValue: 'category' }, defaultFundInfo, {
          id: StockCategory.A,
          name: `${StockCategory.A}${
            globalState.aStockCount > 0 ? `(${globalState.aStockCount})` : ''
          }`,
        }),
        undefined,
        true
      ),
      new LeekTreeItem(
        Object.assign({ contextValue: 'category' }, defaultFundInfo, {
          id: StockCategory.HK,
          name: `${StockCategory.HK}${
            globalState.hkStockCount > 0 ? `(${globalState.hkStockCount})` : ''
          }`,
        }),
        undefined,
        true
      ),
      new LeekTreeItem(
        Object.assign({ contextValue: 'category' }, defaultFundInfo, {
          id: StockCategory.US,
          name: `${StockCategory.US}${
            globalState.usStockCount > 0 ? `(${globalState.usStockCount})` : ''
          }`,
        }),
        undefined,
        true
      ),
      new LeekTreeItem(
        Object.assign({ contextValue: 'category' }, defaultFundInfo, {
          id: StockCategory.Future,
          name: `${StockCategory.Future}${
            globalState.cnfStockCount > 0 ? `(${globalState.cnfStockCount})` : ''
          }`,
        }),
        undefined,
        true
      ),
      new LeekTreeItem(
        Object.assign({ contextValue: 'category' }, defaultFundInfo, {
          id: StockCategory.OverseaFuture,
          name: `${StockCategory.OverseaFuture}${
            globalState.hfStockCount > 0 ? `(${globalState.hfStockCount})` : ''
          }`,
        }),
        undefined,
        true
      ),
    ];
    // 显示接口不支持的股票，避免用户老问为什么添加了股票没反应
    if (globalState.noDataStockCount) {
      nodes.push(
        new LeekTreeItem(
          Object.assign({ contextValue: 'category' }, defaultFundInfo, {
            id: StockCategory.NODATA,
            name: `${StockCategory.NODATA}(${globalState.noDataStockCount})`,
          }),
          undefined,
          true
        )
      );
    }
    return nodes.concat(this.getStockGroupRootNodes());
  }
  getStockGroupRootNodes(): LeekTreeItem[] {
    const nodes: Array<LeekTreeItem> = [];
    const groups = globalState.stockGroups.map((name, index) => {
      const codes: Array<string> = globalState.stockGroupStocks[index] || [];
      const avg = calcStockGroupAvgPercent(this.service.stockList, codes);
      return { name, index, codes, avg };
    });
    // 分组按平均涨跌幅降序排列（涨幅高的靠上，无数据排最后）
    groups.sort((a, b) => {
      const avgA = a.avg === null ? Number.NEGATIVE_INFINITY : a.avg;
      const avgB = b.avg === null ? Number.NEGATIVE_INFINITY : b.avg;
      return avgB - avgA;
    });
    groups.forEach(({ name, index, codes, avg }) => {
      const avgText = avg === null ? '' : ` ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`;
      nodes.push(
        new LeekTreeItem(
          Object.assign({ contextValue: 'stockGroup' }, defaultFundInfo, {
            id: `stockGroup_${index}`,
            name: `${name}${codes.length > 0 ? `(${codes.length})` : ''}${avgText}`,
          }),
          undefined,
          true
        )
      );
    });
    return nodes;
  }
  getStockGroupNodes(groupId: string): Promise<LeekTreeItem[]> {
    const index: number = parseInt((groupId || '').replace('stockGroup_', ''));
    const codes: Array<string> = globalState.stockGroupStocks[index] || [];
    return Promise.resolve(this.service.stockList || []).then((list) => {
      const clones = list
        .filter((item: LeekTreeItem) => codes.includes(item.info.code))
        .map((item: LeekTreeItem) => {
          const clone = Object.create(Object.getPrototypeOf(item)) as LeekTreeItem;
          Object.assign(clone, item);
          clone.id = `${groupId}_${item.info.code}`;
          clone.contextValue = 'stockGroupItem';
          return clone;
        });
      enrichStockTooltips(clones);
      return clones;
    });
  }
  getAStockNodes(stocks: Promise<LeekTreeItem[]>): Promise<LeekTreeItem[]> {
    const aStocks: Promise<LeekTreeItem[]> = stocks.then((res: LeekTreeItem[]) => {
      const arr = res.filter((item: LeekTreeItem) => /^(sh|sz|bj)/.test(item.type || ''));
      return arr;
    });

    return aStocks;
  }
  getHkStockNodes(stocks: Promise<LeekTreeItem[]>): Promise<LeekTreeItem[]> {
    return stocks.then((res: LeekTreeItem[]) =>
      res.filter((item: LeekTreeItem) => /^(hk)/.test(item.type || ''))
    );
  }
  getUsStockNodes(stocks: Promise<LeekTreeItem[]>): Promise<LeekTreeItem[]> {
    return stocks.then((res: LeekTreeItem[]) =>
      res.filter((item: LeekTreeItem) => /^(usr_)/.test(item.type || ''))
    );
  }
  getFutureStockNodes(stocks: Promise<LeekTreeItem[]>): Promise<LeekTreeItem[]> {
    return stocks.then((res: LeekTreeItem[]) =>
      res.filter((item: LeekTreeItem) => /^(nf_)/.test(item.type || ''))
    );
  }
  getOverseaFutureStockNodes(stocks: Promise<LeekTreeItem[]>): Promise<LeekTreeItem[]> {
    return stocks.then((res: LeekTreeItem[]) =>
      res.filter((item: LeekTreeItem) => /^(hf_)/.test(item.type || ''))
    );
  }
  getNoDataStockNodes(stocks: Promise<LeekTreeItem[]>): Promise<LeekTreeItem[]> {
    return stocks.then((res: LeekTreeItem[]) => {
      return res.filter((item: LeekTreeItem) => {
        return /^(nodata)/.test(item.type || '');
      });
    });
  }

  changeOrder(): void {
    let order = this.order as number;
    order += 1;
    if (order > 1) {
      this.order = SortType.DESC;
    } else if (order === 1) {
      this.order = SortType.ASC;
    } else if (order === 0) {
      this.order = SortType.NORMAL;
    }
    LeekFundConfig.setConfig('leek-fund.stockSort', this.order);
    this.refresh();
  }
}
