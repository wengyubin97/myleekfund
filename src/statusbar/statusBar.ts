import { MarkdownString, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import FundService from '../explorer/fundService';
import StockService from '../explorer/stockService';
import globalState from '../globalState';
import { LeekFundConfig } from '../shared/leekConfig';
import { LeekTreeItem } from '../shared/leekTreeItem';
import { calcStockGroupAvgPercent, events } from '../shared/utils';
import {
  buildGroupChartDataUri,
  getGroupSignal,
  getLatestVolumeCompare,
  getMinuteRecords,
  getStockChartDataUri,
  getStockSignal,
  isMinuteSupported,
  signalLabel,
} from './groupChart';
import type { TrendSignal } from './groupChart';

function joinMarkdownLines(lines: Array<string>): string {
  return lines.join('  \n');
}

/** 信号色：快速拉升=大红，快速下降=大绿 */
const SIGNAL_UP_RED = '#E53935';
const SIGNAL_DOWN_GREEN = '#00B050';
/** 闪烁间隙/无数据时的灰色 */
const BAR_GRAY = '#A0A0A0';
/** 快速涨跌提示阈值（%/分钟）：10 秒采样约 0.08%/10s */
const SURGE_FAST_THRESHOLD = 0.5;

export class StatusBar {
  private stockService: StockService;
  private fundService: FundService;
  private fundBarItem: StatusBarItem;
  private statusBarList: StatusBarItem[] = [];
  private statusBarGroupList: StatusBarItem[] = [];
  private statusBarGroupNames: string[] = [];
  /** 快速涨跌提示条：状态栏最左第一位置（轮动），无信号时隐藏 */
  private surgeUpBarItem: StatusBarItem;
  private surgeDownBarItem: StatusBarItem;
  /** 上次 10 秒采样基准价缓存（涨跌速判定用） */
  private surgePriceCache: Map<string, { price: number; time: number }> = new Map();
  constructor(stockService: StockService, fundService: FundService) {
    this.stockService = stockService;
    this.fundService = fundService;
    this.statusBarList = [];
    this.fundBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 3);
    // priority 高于普通分组（100-index）与个股（3），确保占据最左位置
    this.surgeUpBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 210);
    this.surgeDownBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 200);
    this.surgeUpBarItem.hide();
    this.surgeDownBarItem.hide();
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
      this.refreshSurgeStatusBar();
    });
    events.on('fundListUpdate', () => {
      this.refreshFundStatusBar();
    });
  }

  refresh() {
    this.refreshFundStatusBar();
    this.refreshStockStatusBar();
    this.refreshStockGroupStatusBar();
    this.refreshSurgeStatusBar();
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
    const statusBarStocks: string[] = LeekFundConfig.getConfig('leek-fund.statusBarStock');
    // 用 filter 生成紧凑数组（避免稀疏数组空洞导致状态栏条不更新）
    const barStockList: Array<LeekTreeItem> = this.stockService.stockList.filter((stockItem) => {
      const { code } = stockItem.info;
      if (code === 'sh000001') {
        sz = stockItem;
      }
      return statusBarStocks.includes(code);
    });
    // 个股按涨跌幅降序排列（涨幅高的靠左）
    barStockList.sort((a, b) => {
      const pa = parseFloat(a.info.percent);
      const pb = parseFloat(b.info.percent);
      return (
        (isNaN(pb) ? Number.NEGATIVE_INFINITY : pb) -
        (isNaN(pa) ? Number.NEGATIVE_INFINITY : pa)
      );
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
        if (bar) {
          bar.hide();
          bar.dispose();
        }
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
    // 紧凑格式：名称 价格 涨跌幅（去掉图标与括号）
    const priceText = item.info.price || '--';
    const percentText = item.info.percent ? `${item.info.percent}%` : '--';
    stockBarItem.text = `${item.info?.name ?? code} ${priceText} ${percentText}`;
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
    const baseColor = deLow ? this.riseColor : this.fallColor;
    stockBarItem.color = baseColor;
    this.updateStockChartTooltip(stockBarItem, code, mdLines, baseColor);
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
    baseLines: Array<string>,
    baseColor?: string
  ) {
    try {
      const dataUri = await getStockChartDataUri(code);
      const signal = await getStockSignal(code);
      this.setBarFlash(stockBarItem, signal, baseColor);
      const records = await getMinuteRecords([code]);
      const volCmp = getLatestVolumeCompare(records);
      const lines = baseLines.slice();
      // 分时量对比（当前 / 上一根 + MA5 + MA10），插到「更新时间」上方
      if (volCmp) {
        const pctOf = (base: number) => Math.round(Math.abs(volCmp.cur / base - 1) * 100);
        const tagOf = (base: number) => (volCmp.cur >= base ? '放量' : '缩量');
        const volLines: Array<string> = [
          `分时量：当前 ${volCmp.cur} / 上一根 ${volCmp.prev}（${tagOf(volCmp.prev)} ${pctOf(volCmp.prev)}%）`,
        ];
        const maParts: Array<string> = [];
        if (volCmp.ma5 !== null) {
          maParts.push(`MA5 ${tagOf(volCmp.ma5)} ${pctOf(volCmp.ma5)}%`);
        }
        if (volCmp.ma10 !== null) {
          maParts.push(`MA10 ${tagOf(volCmp.ma10)} ${pctOf(volCmp.ma10)}%`);
        }
        if (maParts.length) {
          volLines.push(`量能均线：${maParts.join(' · ')}`);
        }
        const idx = lines.findIndex((l) => l.startsWith('更新时间'));
        if (idx >= 0) {
          lines.splice(idx, 0, ...volLines);
        } else {
          lines.push(...volLines);
        }
      }
      if (signal) {
        lines.push('', `**${signalLabel(signal)}**`);
      }
      if (dataUri) {
        lines.push('', '![分时图](' + dataUri + ')');
      }
      stockBarItem.tooltip = new MarkdownString(joinMarkdownLines(lines));
    } catch (err) {
      console.error('update stock chart tooltip error:', err);
    }
  }

  /** 快速拉升=大红、快速下杀=大绿，无信号=底色（静态显示，不闪烁） */
  setBarFlash(barItem: StatusBarItem, signal: TrendSignal, baseColor?: string) {
    if (!signal) {
      if (baseColor !== undefined) {
        barItem.color = baseColor;
      }
      return;
    }
    barItem.color = signal.direction === 'up' ? SIGNAL_UP_RED : SIGNAL_DOWN_GREEN;
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

  /**
   * 快速涨跌提示：状态栏最左，涨速条与跌速条常驻（无信号时显示 1min 榜）。
   * 涨速条候选优先级：涨停 → 10s 涨速达标 → 1min 涨幅最大；
   * 跌速条对称。显示同时带 10s 涨速与 1min 涨跌幅。
   */
  async refreshSurgeStatusBar() {
    if (this.hideStatusBar || this.hideStatusBarStock) {
      this.surgeUpBarItem.hide();
      this.surgeDownBarItem.hide();
      return;
    }

    const now = Date.now();
    const stocks = this.stockService.stockList;
    const metrics = await Promise.all(
      stocks.map(async (item) => {
        const code = item.info.code;
        const curPrice = parseFloat(item.info.price || '');
        if (isNaN(curPrice) || curPrice <= 0) {
          return null;
        }
        // 10 秒涨速：基准价每约 10 秒更新一次，涨速 = 10 秒涨跌归一化到 %/分钟
        let speed10s = 0;
        const last = this.surgePriceCache.get(code);
        if (last) {
          const elapsedSec = (now - last.time) / 1000;
          if (elapsedSec >= 8 && elapsedSec <= 60) {
            const diffPct = (curPrice / last.price - 1) * 100;
            speed10s = diffPct * (60 / elapsedSec);
          }
          if (elapsedSec >= 8) {
            // 达到采样间隔，更新基准
            this.surgePriceCache.set(code, { price: curPrice, time: now });
          }
        } else {
          this.surgePriceCache.set(code, { price: curPrice, time: now });
        }
        const percent = parseFloat(item.info.percent || '');
        return {
          code,
          name: item.info.name || code,
          percent: isNaN(percent) ? 0 : percent,
          speed10s,
          limit: this.getLimitState(code, item.info.name || '', percent),
        };
      })
    );
    const valid = metrics.filter((m) => m !== null) as Array<{
      code: string;
      name: string;
      percent: number;
      speed10s: number;
      limit: 'up' | 'down' | null;
    }>;

    // 清理不再属于自选股的缓存
    const liveCodes = stocks.map((item) => item.info.code);
    this.surgePriceCache.forEach((_, code) => {
      if (!liveCodes.includes(code)) {
        this.surgePriceCache.delete(code);
      }
    });

    const sortBySpeed = (a: typeof valid[0], b: typeof valid[0]) => b.speed10s - a.speed10s;

    // 涨速条：涨停（仅封板瞬间/仍有买盘冲击时）> 10s 涨速达标 > 10s 涨速最大（常驻兜底）
    const upLimit = valid
      .filter((m) => m.limit === 'up' && m.speed10s > 0)
      .sort((a, b) => b.percent - a.percent);
    const upFast = valid
      .filter((m) => m.limit !== 'up' && m.speed10s >= SURGE_FAST_THRESHOLD)
      .sort(sortBySpeed);
    const upSlow = valid.filter((m) => m.limit !== 'up' && m.speed10s > 0).sort(sortBySpeed);
    // 跌速条：跌停（仅封板瞬间/仍有抛压时）> 10s 跌速达标 > 10s 跌速最大（常驻兜底）
    const downLimit = valid
      .filter((m) => m.limit === 'down' && m.speed10s < 0)
      .sort((a, b) => a.percent - b.percent);
    const downFast = valid
      .filter((m) => m.limit !== 'down' && m.speed10s <= -SURGE_FAST_THRESHOLD)
      .sort(sortBySpeed);
    const downSlow = valid.filter((m) => m.limit !== 'down' && m.speed10s < 0).sort(sortBySpeed);

    const upHit = upLimit[0] ?? upFast[0] ?? upSlow[0];
    const downHit = downLimit[0] ?? downFast[0] ?? downSlow[0];

    if (upHit) {
      const hit = upHit;
      let text: string;
      if (hit.limit === 'up') {
        text = `${this.shortenName(hit.name)} 涨停`;
      } else {
        text = `${this.shortenName(hit.name)} +${Number(hit.speed10s.toFixed(1))}%`;
      }
      this.surgeUpBarItem.text = text;
      this.surgeUpBarItem.color = SIGNAL_UP_RED;
      this.surgeUpBarItem.command = {
        title: 'Change stock',
        command: 'leek-fund.changeStatusBarItem',
        arguments: [this.findStockId(hit.code)],
      };
      this.updateSurgeTooltip(this.surgeUpBarItem, hit, '涨');
      this.surgeUpBarItem.show();
    } else {
      this.surgeUpBarItem.hide();
    }

    if (downHit) {
      const hit = downHit;
      let text: string;
      if (hit.limit === 'down') {
        text = `${this.shortenName(hit.name)} 跌停`;
      } else {
        text = `${this.shortenName(hit.name)} ${Number(hit.speed10s.toFixed(1))}%`;
      }
      this.surgeDownBarItem.text = text;
      this.surgeDownBarItem.color = SIGNAL_DOWN_GREEN;
      this.surgeDownBarItem.command = {
        title: 'Change stock',
        command: 'leek-fund.changeStatusBarItem',
        arguments: [this.findStockId(hit.code)],
      };
      this.updateSurgeTooltip(this.surgeDownBarItem, hit, '跌');
      this.surgeDownBarItem.show();
    } else {
      this.surgeDownBarItem.hide();
    }
  }

  /** 状态栏名称长度控制：>4 字截前 4 字；≤2 字保持原样（无更长数据源可补全） */
  private shortenName(name: string): string {
    if (name.length > 4) {
      return name.slice(0, 4);
    }
    return name;
  }

  /** A股涨跌停判定（主板 10%、创业/科创 20%、北交所 30%、ST 5%）；港股/美股/期货无涨跌停 */
  private getLimitState(code: string, name: string, percent: number): 'up' | 'down' | null {
    const match = code.match(/^(sh|sz|bj)(\d{6})/);
    if (!match) {
      return null;
    }
    const num = match[2];
    let threshold = 10;
    if (/^(688|30)/.test(num)) {
      threshold = 20;
    } else if (/^[48]/.test(num)) {
      threshold = 30;
    } else if (/ST/i.test(name)) {
      threshold = 5;
    }
    if (percent >= threshold - 0.1) {
      return 'up';
    }
    if (percent <= -(threshold - 0.1)) {
      return 'down';
    }
    return null;
  }

  /** 按代码查找自选股条目 id（用于切换状态栏展示） */
  private findStockId(code: string): string {
    const item = this.stockService.stockList.find((stock) => stock.info.code === code);
    return item?.id || code;
  }

  async updateSurgeTooltip(
    barItem: StatusBarItem,
    hit: {
      code: string;
      name: string;
      percent: number;
      speed10s: number;
      limit: 'up' | 'down' | null;
    },
    direction: '涨' | '跌'
  ) {
    try {
      const dataUri = await getStockChartDataUri(hit.code);
      const lines: Array<string> = [
        `${hit.name}（${hit.code}） ${hit.percent >= 0 ? '+' : ''}${hit.percent}%`,
        `${direction}速 ${Math.abs(hit.speed10s).toFixed(2)}%/分钟`,
      ];
      if (dataUri) {
        lines.push('', `![分时图](${dataUri})`);
      }
      barItem.tooltip = new MarkdownString(joinMarkdownLines(lines));
    } catch (err) {
      console.error('update surge tooltip error:', err);
    }
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
    const baseColor = group.avg === null ? undefined : group.avg >= 0 ? this.riseColor : this.fallColor;
    groupBarItem.color = baseColor;
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
    this.updateGroupChartTooltip(groupBarItem, chartCodes, mdLines, baseColor);
    groupBarItem.show();
    return groupBarItem;
  }

  async updateGroupChartTooltip(
    groupBarItem: StatusBarItem,
    codes: Array<string>,
    baseLines: Array<string>,
    baseColor?: string
  ) {
    try {
      const supportedCount = codes.filter(isMinuteSupported).length;
      if (!supportedCount) {
        this.setBarFlash(groupBarItem, null, baseColor);
        return;
      }
      const dataUri = await buildGroupChartDataUri(codes);
      const signal = await getGroupSignal(codes);
      this.setBarFlash(groupBarItem, signal, baseColor);
      if (!dataUri) {
        return;
      }
      const lines = baseLines.slice();
      if (signal) {
        lines.push('', `**${signalLabel(signal)}**`);
      }
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
