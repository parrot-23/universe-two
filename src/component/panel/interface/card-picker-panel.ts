// 卡片选择面板：界面视图编辑模式下从左下角「添加」按钮打开，选择要加入界面的卡片。
// 方块样式复用工作台添加卡片菜单。
import { setIcon } from 'obsidian';

import { t } from '../../../i18n';
import { FloatingPanel, type FloatingPanelOptions } from '../basic/floating-panel';

/** 可添加的卡片：id + 图标 + 文案 key */
const CARD_ITEMS: { id: string; icon: string; labelKey: Parameters<typeof t>[0] }[] = [
    { id: 'date', icon: 'calendar-day', labelKey: 'interface.cardDate' },
    { id: 'nav', icon: 'panel-right', labelKey: 'interface.cardNav' },
    { id: 'today-clock', icon: 'clock', labelKey: 'interface.cardTodayClock' },
    { id: 'today-tasks', icon: 'list-checks', labelKey: 'interface.cardTodayTasks' },
    { id: 'today-tasks-simple', icon: 'layout-list', labelKey: 'interface.cardTodayTasksSimple' },
    { id: 'clock', icon: 'clock-4', labelKey: 'interface.cardClock' },
];

export class CardPickerPanel extends FloatingPanel {
    constructor(onPick: (cardId: string) => void, options: Pick<FloatingPanelOptions, 'container'> = {}) {
        super({
            title: t('interface.cardPickerTitle'),
            width: 360,
            closeOnBlur: true,
            container: options.container,
        });

        this.setContent((body) => {
            const grid = body.createDiv({ cls: 'wb-add-section-grid' });
            for (const { id, icon, labelKey } of CARD_ITEMS) {
                const item = grid.createDiv({ cls: 'wb-add-menu-item' });
                const iconEl = item.createDiv({ cls: 'wb-add-menu-item-icon' });
                setIcon(iconEl, icon);
                item.createDiv({ cls: 'wb-add-menu-item-label', text: t(labelKey) });
                item.addEventListener('click', () => {
                    this.close();
                    onPick(id);
                });
            }
        });
    }
}
