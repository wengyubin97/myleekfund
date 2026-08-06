import { MarkdownString, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import FundService from '../explorer/fundService';
import StockService from '../explorer/stockService';
import globalState from '../globalState';
import { DEFAULT_LABEL_FORMAT } from '../shared/constant';
import { LeekFundConfig } from '../shared/leekConfig';
import { LeekTreeItem } from '../shared/leekTreeItem';
import { calcStockGroupAvgPercent, events, formatLabelString } from '../shared/utils';
import { buildGroupChartDataUri, isMinuteSupported } from './groupChart';

function joinMarkdownLines(lines: Array<string>): string {
  return lines.join('  \n');
}

export class StatusBar {
  private stockService: StockService;
  private fundService: FundService;
  private fundBarItem: StatusBarItem;
  private statusBarList: StatusBarItem[] = [];
  private statusBarGroupList: StatusBarItem[] = [];
  private statusBarGroupNames: string[] = [];
  private statusBarItemLabelFormat: string = '';
  constructor(stockService: StockService, fundService: FundService) {
    this.stockService = stockService;
    this.fundService = fundService;
    this.statusBarList = [];
    this.fundBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 3);
    this.refreshStockStatusBar();
    this.bindEvents();
    /* events.on('updateConfig:leek-fund.statusBarStock',()=>{

    }) */
  }

  get riseColor(): string {
    return LeekFundConfig.getConfig('leek-fund.riseColor');
  }

  get fallColor(): string {
    return LeekFundConfig.getConfig('leek-fund.fallColor');
  }

  /** 隐藏股市状态栏 */
  get hideStatusBarStock(): boolean {
    return LeekFundConfig.getConfig('leek-fund.hideStatusBarStock');
  }

  /** 隐藏状态栏 */
  get hideStatusBar(): boolean {
    return LeekFundConfig.getConfig('leek-fund.hideStatusBar');
  }

  /** 隐藏基金状态栏 */
  get hideFundBarItem(): boolean {
    return LeekFundConfig.getConfig('leek-fund.hideFundBarItem');
  }

  /** 隐藏图标 */
  get hideStatusBarIcon(): boolean {
    return LeekFundConfig.getConfig('leek-fund.hideStatusBarIcon');
  }

  bindEvents() {
    events.on('stockListUpdate', () => {
      this.refreshStockStatusBar();
      this.refreshStockGroupStatusBar();
    });
    events.on('fundListUpdate', () => {
      this.refreshFundStatusBar();
    });
  }

  refresh() {
    this.refreshFundStatusBar();
    this.refreshStockStatusBar();
    this.refreshStockGroupStatusBar();
  }

  /** 切换状态栏显示 */
  toggleVisibility() {
    LeekFundConfig.setConfig('leek-fund.hideStatusBar', !this.hideStatusBar);
    this.refresh();
  }

  /** 切换基金状态栏显示 */
  toggleFundBarVisibility() {
    LeekFundConfig.setConfig('leek-fund.hideFundBarItem', !this.hideFundBarItem);
    this.refreshFundStatusBar();
  }

  /** 切换股票状态栏显示 */
  toggleStockBarVisibility() {
    LeekFundConfig.setConfig('leek-fund.hideStatusBarStock', !this.hideStatusBarStock);
    this.refreshStockStatusBar();
  }

  /** 切换图标显示 */
  toggleStatusBarIconVisibility() {
    LeekFundConfig.setConfig('leek-fund.hideStatusBarIcon', !this.hideStatusBarIcon);
    this.refresh();
  }

  refreshStockStatusBar() {
    if (this.hideStatusBar || this.hideStatusBarStock || !this.stockService.stockList.length) {
      if (this.statusBarList.length) {
        this.statusBarList.forEach((bar) => bar.dispose());
        this.statusBarList = [];
      }
      return;
    }

    let sz: LeekTreeItem | null = null;
    const statusBarStocks = LeekFundConfig.getConfig('leek-fund.statusBarStock');
    const barStockList: Array<LeekTreeItem> = new Array(statusBarStocks.length);

    this.statusBarItemLabelFormat =
      globalState.labelFormat?.['statusBarLabelFormat'] ??
      DEFAULT_LABEL_FORMAT.statusBarLabelFormat;

    this.stockService.stockList.forEach((stockItem) => {
      const { code } = stockItem.info;
      if (code === 'sh000001') {
        sz = stockItem;
      }
      if (statusBarStocks.includes(code)) {
        // barStockList.push(stockItem);
        barStockList[statusBarStocks.indexOf(code)] = stockItem;
      }
    });

    if (!barStockList.length) {
      barStockList.push(sz || this.stockService.stockList[0]);
    }

    let count = barStockList.length - this.statusBarList.length;
    if (count > 0) {
      while (--count >= 0) {
        const stockBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 3);
        this.statusBarList.push(stockBarItem);
      }
    } else if (count < 0) {
      let num = Math.abs(count);
      while (--num >= 0) {
        const bar = this.statusBarList.pop();
        bar?.hide();
        bar?.dispose();
      }
    }
    barStockList.forEach((stock, index) => {
      this.updateBarInfo(this.statusBarList[index], stock);
    });
  }

  updateBarInfo(stockBarItem: StatusBarItem, item: LeekTreeItem | null) {
    if (!item) return;
    const {
      code,
      percent,
      open,
      yestclose,
      high,
      low,
      updown,
      amount,
      afterPrice,
      afterPercent,
      heldAmount,
      heldPrice,
    } = item.info;
    const deLow = percent.indexOf('-') === -1;
    // Respect hideStatusBarIcon config
    const icon = this.hideStatusBarIcon ? '' : (deLow ? '📈' : '📉');
    stockBarItem.text = formatLabelString(this.statusBarItemLabelFormat, {
      ...item.info,
      percent: `${percent}%`,
      icon,
    });
    let heldText = '';
    if (heldAmount && heldPrice) {
      heldText = `成本：${heldPrice}   持仓：${heldAmount}\n`;
    }
    let afterText = '';
    if (afterPrice) {
      afterText = `盘后：${afterPrice}   涨跌幅：${afterPercent}%\n`;
    }
    const mdLines: Array<string> = [
      `「今日行情」 ${item.info?.name ?? '今日行情'}（${code}）`,
      `涨跌：${updown}   百分：${percent}%`,
      `最高：${high}   最低：${low}`,
      `今开：${open}   昨收：${yestclose}`,
    ];
    if (afterText.trim()) {
      mdLines.push(afterText.trim());
    }
    if (heldText.trim()) {
      mdLines.push(heldText.trim());
    }
    mdLines.push(`成交额：${amount}`, `更新时间：${item.info?.time}`);
    stockBarItem.tooltip = new MarkdownString(joinMarkdownLines(mdLines));
    // 异步渲染当前分时图（data URI 内嵌，与分组图一致，含零轴/最高/最低标注）
    this.updateStockChartTooltip(stockBarItem, code, mdLines);
    stockBarItem.color = deLow ? this.riseColor : this.fallColor;
    stockBarItem.command = {
      title: 'Change stock',
      command: 'leek-fund.changeStatusBarItem',
      arguments: [item.id],
    };

    stockBarItem.show();
    return stockBarItem;
  }

  async updateStockChartTooltip(
    stockBarItem: StatusBarItem,
    code: string,
    baseLines: Array<string>
  ) {
    try {
      const dataUri = await buildGroupChartDataUri([code]);
      if (!dataUri) {
        return;
      }
      const lines = baseLines.slice();
      lines.push('', '![分时图](' + dataUri + ')');
      stockBarItem.tooltip = new MarkdownString(joinMarkdownLines(lines));
    } catch (err) {
      console.error('update stock chart tooltip error:', err);
    }
  }

  refreshStockGroupStatusBar() {
    if (this.hideStatusBar || this.hideStatusBarStock) {
      this.disposeGroupBarItems();
      return;
    }

    const groupNames: Array<string> = LeekFundConfig.getConfig(
      'leek-fund.statusBarStockGroups'
    ) || [];
    let barGroups = groupNames
      .map((name) => {
        const index = globalState.stockGroups.indexOf(name);
        if (index === -1) {
          return null;
        }
        const codes: Array<string> = globalState.stockGroupStocks[index] || [];
        const avg = calcStockGroupAvgPercent(this.stockService.stockList, codes);
        return { name, codes, avg };
      })
      .filter((group) => !!group) as Array<{
      name: string;
      codes: Array<string>;
      avg: number | null;
    }>;

    // 按平均涨幅降序排列：涨幅越高的分组越靠左
    barGroups.sort((a, b) => {
      const avgA = a.avg === null ? Number.NEGATIVE_INFINITY : a.avg;
      const avgB = b.avg === null ? Number.NEGATIVE_INFINITY : b.avg;
      return avgB - avgA;
    });

    // 顺序变化时重建状态栏项（priority 只读，只能通过重建调整位置）
    const targetNames = barGroups.map((group) => group.name).join('\u0000');
    const currentNames = this.statusBarGroupNames.join('\u0000');
    if (targetNames !== currentNames) {
      this.disposeGroupBarItems();
    }

    let count = barGroups.length - this.statusBarGroupList.length;
    if (count > 0) {
      while (--count >= 0) {
        const priority = 100 - this.statusBarGroupList.length;
        this.statusBarGroupList.push(window.createStatusBarItem(StatusBarAlignment.Left, priority));
      }
    } else if (count < 0) {
      let num = Math.abs(count);
      while (--num >= 0) {
        const bar = this.statusBarGroupList.pop();
        bar?.hide();
        bar?.dispose();
      }
    }

    this.statusBarGroupNames = barGroups.map((group) => group.name);
    barGroups.forEach((group, index) => {
      this.updateGroupBarInfo(this.statusBarGroupList[index], group);
    });
  }

  disposeGroupBarItems() {
    this.statusBarGroupList.forEach((bar) => {
      bar.hide();
      bar.dispose();
    });
    this.statusBarGroupList = [];
    this.statusBarGroupNames = [];
  }

  updateGroupBarInfo(
    groupBarItem: StatusBarItem,
    group: { name: string; codes: Array<string>; avg: number | null }
  ) {
    const arrow =
      group.avg === null ? '' : group.avg >= 0 ? '↑' : '↓';
    const icon = this.hideStatusBarIcon ? '' : arrow;
    const avgText =
      group.avg === null ? '--' : `${group.avg >= 0 ? '+' : ''}${group.avg.toFixed(2)}%`;
    groupBarItem.text = [icon, group.name, avgText].filter((v) => v !== '').join(' ');
    groupBarItem.color = group.avg === null ? undefined : group.avg >= 0 ? this.riseColor : this.fallColor;
    groupBarItem.command = {
      title: 'Change stock group',
      command: 'leek-fund.changeStatusBarGroupItem',
      arguments: [group.name],
    };

    const memberItems = this.stockService.stockList
      .filter((item) => group.codes.includes(item.info.code))
      .sort((a, b) => {
        const percentA = parseFloat(a.info.percent);
        const percentB = parseFloat(b.info.percent);
        const numA = isNaN(percentA) ? Number.NEGATIVE_INFINITY : percentA;
        const numB = isNaN(percentB) ? Number.NEGATIVE_INFINITY : percentB;
        return numB - numA;
      });
    const mdLines: Array<string> = [
      `【分组行情】${group.name}`,
      `平均涨幅: ${avgText}`,
      '-----------------------------',
    ];
    memberItems.forEach((item) => {
      const percentText = item.info.percent ? `${item.info.percent}%` : '--';
      mdLines.push(`${percentText}   ${item.info.name}`);
    });
    const chartCodes = memberItems.map((item) => item.info.code);
    groupBarItem.tooltip = new MarkdownString(joinMarkdownLines(mdLines));
    // 等权合成分时图：异步生成并以内嵌 data URI 展示（避免本地图片链接被拦截）
    this.updateGroupChartTooltip(groupBarItem, chartCodes, mdLines);
    groupBarItem.show();
    return groupBarItem;
  }

  async updateGroupChartTooltip(
    groupBarItem: StatusBarItem,
    codes: Array<string>,
    baseLines: Array<string>
  ) {
    try {
      const supportedCount = codes.filter(isMinuteSupported).length;
      if (!supportedCount) {
        return;
      }
      const dataUri = await buildGroupChartDataUri(codes);
      if (!dataUri) {
        return;
      }
      const lines = baseLines.slice();
      lines.push('');
      lines.push(`**等权分时（${supportedCount} 只）**`);
      lines.push(`![等权分时图](${dataUri})`);
      if (supportedCount < codes.length) {
        lines.push('（美股/期货暂无分时数据，未计入）');
      }
      groupBarItem.tooltip = new MarkdownString(joinMarkdownLines(lines));
    } catch (err) {
      console.error('update group chart tooltip error:', err);
    }
  }

  refreshFundStatusBar() {
    // 隐藏基金状态栏
    if (this.hideStatusBar || this.hideFundBarItem) {
      this.fundBarItem.hide();
      return;
    }

    // Respect hideStatusBarIcon config for fund bar
    const icon = this.hideStatusBarIcon ? '' : '🐥';
    this.fundBarItem.text = `${icon}\$(pulse)`;
    this.fundBarItem.color = this.riseColor;
    this.fundBarItem.tooltip = this.getFundTooltipText();
    this.fundBarItem.show();
    return this.fundBarItem;
  }

  private getFundTooltipText() {
    let fundTemplate = '';
    for (let fund of this.fundService.fundList.slice(0, 14)) {
      const detailInfo = fund.info || { percent: '' };
      fundTemplate += `${
        detailInfo.percent?.indexOf('-') === 0 ? ' ↓ ' : detailInfo.percent === '0.00' ? '' : ' ↑ '
      } ${detailInfo.percent}%   「${
        detailInfo.name
      }」\n--------------------------------------------\n`;
    }
    // tooltip 有限定高度，所以只展示最多14只基金
    const tips = this.fundService.fundList.length >= 14 ? '（只展示前14只）' : '';
    return `「基金详情」\n\n ${fundTemplate}${tips}`;
  }
}
