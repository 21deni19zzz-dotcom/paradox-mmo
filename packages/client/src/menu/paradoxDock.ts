/**
 * Paradox Dock — универсальный декоративный контейнер для Kaetram-меню.
 *
 * Архитектура (skill kaetram-mmo §10.1 — "правильный overlay"):
 *   - DOM #paradox-dock — position:fixed, прямой потомок <body>, сиблинг #game-container.
 *     НЕ вложен в #border / #canvas / #game-container → canvas viewport Kaetram не трогается.
 *   - При show(title, menuElement, onClose) физически перемещает menuElement
 *     (например #inventory) внутрь #paradox-dock-body. Оригинальная позиция
 *     (parent + nextSibling) запоминается.
 *   - При hide() запускает slide-out, дожидается конца transition, возвращает
 *     DOM-узел в исходную позицию, чтобы ничего не ломалось в Kaetram-логике.
 *
 * Почему именно так, а не CSS-рамка поверх существующего меню:
 *   Попытки Sprint 2 v2 (commits 625ce0b / 205045a / ea5ea71 — откачены) применяли
 *   Golden UI border/padding к #inventory внутри #border. Это ломало DOM-размеры
 *   HUD-контейнеров, canvas viewport Kaetram считал неправильный hit-test,
 *   клики по мобам становились мёртвыми. Перенос DOM за пределы #border этого избегает.
 *
 * Singleton: ссылка на единственный экземпляр доступна через ParadoxDock.getInstance() —
 *   это упрощает вызов из menu-подклассов (Inventory и др.), которые не имеют
 *   прямой ссылки на MenuController.
 */
export default class ParadoxDock {
    private static instance: ParadoxDock | null = null;

    private element: HTMLElement;
    private titleEl: HTMLElement;
    private bodyEl: HTMLElement;
    private closeBtn: HTMLButtonElement;

    // Состояние перенесённого узла.
    private hostedElement: HTMLElement | null = null;
    private originalParent: Node | null = null;
    private originalNextSibling: Node | null = null;
    private onCloseCallback: (() => void) | null = null;

    // Идёт ли сейчас анимация закрытия (блок против повторного show до возврата DOM).
    private animatingOut = false;

    // Длительность slide-out должна совпадать с transition в _paradox-dock.scss.
    private readonly CLOSE_ANIMATION_MS = 260;

    public constructor() {
        this.element = document.querySelector('#paradox-dock')!;
        this.titleEl = document.querySelector('#paradox-dock-title')!;
        this.bodyEl = document.querySelector('#paradox-dock-body')!;
        this.closeBtn = document.querySelector('#paradox-dock-close')!;

        if (!this.element || !this.titleEl || !this.bodyEl || !this.closeBtn)
            throw new Error(
                '[ParadoxDock] DOM not ready: one of #paradox-dock / -title / -body / -close missing'
            );

        this.closeBtn.addEventListener('click', () => this.handleCloseClick());

        // NB: Escape обрабатывается централизованно в controllers/input.ts handleKeyDown
        // (case 'Escape' вызывает game.menu.hide() → override hide() каждого меню →
        // ParadoxDock.getInstance()?.hide(this.container)). Дублирующий document listener
        // убран — он создавал двойной fadeOut и лишнюю работу.

        ParadoxDock.instance = this;
    }

    /**
     * Возвращает существующий экземпляр ParadoxDock или null, если controller ещё не создан.
     * Используется в menu-подклассах (inventory.ts и др.) для связи без прямой зависимости
     * от MenuController.
     */
    public static getInstance(): ParadoxDock | null {
        return ParadoxDock.instance;
    }

    /**
     * Показать dock, перенеся в него указанное menu-меню.
     *
     * @param title Заголовок (например "Инвентарь").
     * @param menuElement DOM-узел меню, которое нужно обернуть (например document.querySelector('#inventory')).
     * @param onClose Callback, вызываемый когда пользователь нажал ✕ или Esc.
     */
    public show(title: string, menuElement: HTMLElement, onClose: () => void): void {
        if (this.animatingOut) return; // защита от гонки

        // Если dock уже занят другим меню — закрываем предыдущее синхронно.
        if (this.hostedElement && this.hostedElement !== menuElement) this.restoreHostedNow();

        // Сохраняем оригинальную позицию DOM, чтобы вернуть после hide().
        this.originalParent = menuElement.parentNode;
        this.originalNextSibling = menuElement.nextSibling;
        this.hostedElement = menuElement;
        this.onCloseCallback = onClose;

        // Физический перенос DOM (ссылки addEventListener и внутренние querySelector'ы
        // сохраняются — это одна из гарантий DOM API).
        this.bodyEl.appendChild(menuElement);

        this.titleEl.textContent = title;
        this.element.classList.add('paradox-dock-visible');
    }

    /**
     * Закрыть dock, запустить slide-out и вернуть DOM-узел в исходную позицию.
     *
     * @param hostedElement Опциональная guard-проверка: если передано, dock закроется
     *   ТОЛЬКО если сейчас hosted именно этот элемент. Нужно чтобы override hide()
     *   одного меню случайно не закрыл dock, в котором уже открыто другое меню.
     *
     *   Сценарий P0-бага: user нажимает I (dock с inventory), потом C (profile).
     *   profile.show() → dock.show(profile) → restoreHostedNow(inventory) → dock теперь hosts profile.
     *   Затем super.show() → MenuController.hide() → forEach → inventory.hide() (т.к. isVisible
     *   по inline display:flex) → ParadoxDock.getInstance()?.hide(inventoryContainer) →
     *   сейчас hosted=profileContainer → guard не пройдёт → dock НЕ закрывается.
     *
     *   Важно: hide() без параметра закроет dock в любом случае (backward-compat для случаев
     *   когда нужно принудительно закрыть, но в override menu-меню ВСЕГДА передаём this.container).
     *
     * Не вызывает onClose — это закрытие "изнутри" (sync с Kaetram hide()).
     * Для закрытия по кнопке ✕ используется handleCloseClick.
     */
    public hide(hostedElement?: HTMLElement): void {
        // Guard: если меню просит закрыть dock, но сейчас hosted другой — игнорируем.
        if (hostedElement && this.hostedElement !== hostedElement) return;

        if (!this.isVisible() || this.animatingOut) return;

        this.animatingOut = true;
        this.element.classList.remove('paradox-dock-visible');

        // Ждём конца transition, возвращаем DOM-узел в исходное место.
        setTimeout(() => {
            this.restoreHostedNow();
            this.animatingOut = false;
        }, this.CLOSE_ANIMATION_MS);
    }

    /**
     * Возвращает DOM-узел в исходное место без анимации (используется для форсированной
     * очистки перед показом другого меню или при восстановлении после ошибок).
     */
    private restoreHostedNow(): void {
        if (!this.hostedElement || !this.originalParent) {
            this.hostedElement = null;
            this.originalParent = null;
            this.originalNextSibling = null;
            this.onCloseCallback = null;
            return;
        }

        if (this.originalNextSibling)
            this.originalParent.insertBefore(this.hostedElement, this.originalNextSibling);
        else this.originalParent.appendChild(this.hostedElement);

        this.hostedElement = null;
        this.originalParent = null;
        this.originalNextSibling = null;
        this.onCloseCallback = null;
    }

    /**
     * Обработка клика по ✕ — делегирует Kaetram-меню (через callback), которое само
     * вызовет свой hide() и тем самым закроет dock через patched hide().
     */
    private handleCloseClick(): void {
        this.onCloseCallback?.();
    }

    /**
     * @returns Видим ли dock сейчас (имеет класс paradox-dock-visible).
     */
    public isVisible(): boolean {
        return this.element.classList.contains('paradox-dock-visible');
    }
}
