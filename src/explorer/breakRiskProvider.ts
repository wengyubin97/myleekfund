import { EventEmitter, ThemeIcon, TreeDataProvider, TreeItem } from 'vscode';
import { BreakCheckOutcome } from '../service/breakRiskService';

const DECISION_ORDER: Record<string, number> = { SELL_NOW: 0, OBSERVE: 1, HOLD: 2 };

/** 破位风控树视图：显示全部自选股的尾盘判定结果 */
export class BreakRiskProvider implements TreeDataProvider<BreakCheckOutcome> {
  private _onDidChangeTreeData: EventEmitter<BreakCheckOutcome | undefined> =
    new EventEmitter<BreakCheckOutcome | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private outcomes: Array<BreakCheckOutcome> = [];
  private checkedAt = '';

  setOutcomes(outcomes: Array<BreakCheckOutcome>, checkedAt: string) {
    this.outcomes = outcomes;
    this.checkedAt = checkedAt;
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(): Array<BreakCheckOutcome> {
    return this.outcomes.slice().sort((a, b) => {
      const orderDiff = (DECISION_ORDER[a.decision] ?? 9) - (DECISION_ORDER[b.decision] ?? 9);
      return orderDiff !== 0 ? orderDiff : a.name.localeCompare(b.name, 'zh');
    });
  }

  getTreeItem(outcome: BreakCheckOutcome): TreeItem {
    const item = new TreeItem(`${outcome.name}  ${outcome.decision}`);
    item.iconPath =
      outcome.decision === 'SELL_NOW'
        ? new ThemeIcon('error')
        : outcome.decision === 'OBSERVE'
        ? new ThemeIcon('warning')
        : new ThemeIcon('check');
    item.description = outcome.reason;
    item.tooltip = outcome.reason;
    item.contextValue = 'breakRiskItem';
    return item;
  }

  getStatusText(): string {
    return this.checkedAt
      ? `更新于 ${this.checkedAt}`
      : '尚未检查（尾盘 14:55 自动检查，或运行 Leek: 破位风控检查）';
  }
}
