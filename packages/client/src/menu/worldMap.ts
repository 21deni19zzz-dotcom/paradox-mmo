import Menu from './menu';

import log from '../lib/log';

import { Modules } from '@kaetram/common/network';

import type Game from '../game';

/**
 * WorldMap — полноэкранный overlay с картой мира.
 *
 * Sprint 3 Заход 1+2 (Paradox Online):
 *  - Заход 1: Canvas 2D рендер 1 пиксель = 1 тайл (1152×1008 = 297 Мп тайлов — недопустимо
 *    рендерить через тайлсеты; minimap-стиль стандарт для MMO).
 *  - pan: drag мышью / одним пальцем; zoom: wheel / pinch двумя пальцами.
 *  - Esc или крестик закрывают overlay.
 *  - Заход 2: туман войны по регионам (MAP_DIVISION_SIZE = 48). Регион считается
 *    "открытым", если он был загружен в текущей сессии ИЛИ присутствует в серверном
 *    списке `Player.regionsLoaded` (приходит в welcome-packet как `discoveredRegions`).
 *    Сам список регионов уже персистится в MongoDB (поле `regionsLoaded` в PlayerInfo).
 *
 * Жёсткие правила (урок Sprint 2):
 *  - overlay — прямой потомок <body>, position: fixed, НИКОГДА не внутри
 *    #game-container/#border/#canvas. Canvas движка считает viewport из DOM
 *    размеров этих контейнеров — любой padding/border ломает hit-тест мышью по мобам.
 *  - никаких :root { --var } в связанном SCSS, никаких !important.
 */
export default class WorldMap extends Menu {
    public override identifier: number = Modules.Interfaces.Warp;

    // ── DOM элементы ──
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private statsEl: HTMLElement;

    // ── Параметры мира ──
    private worldTiles = 0; // ширина в тайлах
    private worldTilesH = 0; // высота в тайлах
    private regionSize = 48; // MAP_DIVISION_SIZE — дублируем из common, чтобы не лезть в Map
    private regionsWide = 0; // число регионов по горизонтали
    private regionsTall = 0; // число регионов по вертикали
    private totalRegions = 0;

    // ── Предварительно отрендеренное offscreen-изображение карты (1px/тайл) ──
    private worldImage: HTMLCanvasElement | null = null;
    private worldImageDirty = true;

    // ── Персистентные регионы (с сервера, Заход 2) ──
    private discoveredRegions = new Set<number>();

    // ── Viewport состояние ──
    private scale = 0.5; // визуальный масштаб; 1.0 = 1 canvas-пиксель на тайл
    private minScale = 0.25;
    private maxScale = 8;
    private offsetX = 0; // смещение в пикселях ДО применения scale
    private offsetY = 0;

    // ── Pointer ──
    private dragging = false;
    private dragPointerId: number | null = null;
    private lastPointerX = 0;
    private lastPointerY = 0;

    // ── Pinch (два пальца) ──
    private pointers = new Map<number, { x: number; y: number }>();
    private pinchStartDist = 0;
    private pinchStartScale = 1;
    private pinchAnchor = { x: 0, y: 0 };

    // ── Animation loop ──
    private rafId = 0;
    private lastPlayerTile = { x: -1, y: -1 };
    private pulsePhase = 0;

    public constructor(private game: Game) {
        super('#world-map', '#close-world-map');

        this.canvas = this.container.querySelector('#world-map-canvas') as HTMLCanvasElement;
        this.statsEl = this.container.querySelector('#world-map-stats') as HTMLElement;

        let ctx = this.canvas.getContext('2d');
        if (!ctx) throw new Error('WorldMap: no 2D context');
        this.ctx = ctx;

        this.bindEvents();
    }

    // ─────────────────────────────────────────────────────────────
    // Инициализация (ленивая, при первом открытии)
    // ─────────────────────────────────────────────────────────────

    private initWorldDims(): void {
        if (this.worldTiles) return; // уже инициализировано

        this.worldTiles = this.game.map.width;
        this.worldTilesH = this.game.map.height;
        this.regionsWide = Math.ceil(this.worldTiles / this.regionSize);
        this.regionsTall = Math.ceil(this.worldTilesH / this.regionSize);
        this.totalRegions = this.regionsWide * this.regionsTall;
    }

    /**
     * Применяется при welcome-packet: принимает список ID регионов,
     * которые игрок открыл в предыдущих сессиях.
     */
    public setDiscoveredRegions(regions: number[] | undefined): void {
        if (!regions) return;

        for (let r of regions) this.discoveredRegions.add(r);
        this.worldImageDirty = true;
    }

    /**
     * Вызывается из Map.loadRegionTileData когда новый регион приходит с сервера.
     * Добавляет регион в набор открытых и инвалидирует offscreen image.
     */
    public markRegionDiscovered(region: number): void {
        if (this.discoveredRegions.has(region)) return;

        this.discoveredRegions.add(region);
        this.worldImageDirty = true;
    }

    // ─────────────────────────────────────────────────────────────
    // Offscreen рендер мира (1 пиксель = 1 тайл)
    // ─────────────────────────────────────────────────────────────

    private renderWorldImage(): void {
        if (!this.worldImageDirty) return;
        this.initWorldDims();

        if (!this.worldImage) {
            this.worldImage = document.createElement('canvas');
            this.worldImage.width = this.worldTiles;
            this.worldImage.height = this.worldTilesH;
        }

        let wctx = this.worldImage.getContext('2d', { willReadFrequently: true });
        if (!wctx) return;

        let img = wctx.createImageData(this.worldTiles, this.worldTilesH),
            pixels = img.data,
            map = this.game.map;

        // Цвета палитры (RGB) — локальные, без CSS vars
        const FOG = [15, 15, 20, 255],
            UNDISCOVERED = [28, 30, 40, 220],
            PASSABLE = [74, 123, 74, 255],
            COLLIDER = [110, 100, 90, 255];

        for (let y = 0; y < this.worldTilesH; y++) {
            for (let x = 0; x < this.worldTiles; x++) {
                let idx = y * this.worldTiles + x,
                    regIdx = this.getRegionIndex(x, y),
                    tileData = map.data[idx],
                    discovered = this.discoveredRegions.has(regIdx),
                    hasTile = !!tileData,
                    px = idx * 4,
                    rgba: number[];

                if (!discovered && !hasTile) {
                    rgba = FOG;
                } else if (discovered && !hasTile) {
                    // Регион в истории, но сейчас не подгружен — приглушённый оттенок
                    rgba = UNDISCOVERED;
                } else {
                    // Регион активно подгружен — показываем реальную геометрию
                    let grid = map.grid[y]?.[x];
                    rgba = grid === 1 ? COLLIDER : PASSABLE;
                }

                pixels[px] = rgba[0];
                pixels[px + 1] = rgba[1];
                pixels[px + 2] = rgba[2];
                pixels[px + 3] = rgba[3];
            }
        }

        wctx.putImageData(img, 0, 0);
        this.worldImageDirty = false;
    }

    private getRegionIndex(tileX: number, tileY: number): number {
        let rx = Math.floor(tileX / this.regionSize),
            ry = Math.floor(tileY / this.regionSize);
        return ry * this.regionsWide + rx;
    }

    // ─────────────────────────────────────────────────────────────
    // Рендер (ежекадровый)
    // ─────────────────────────────────────────────────────────────

    private render(): void {
        if (!this.isVisible()) return;

        let cw = this.canvas.clientWidth,
            ch = this.canvas.clientHeight;

        // Защита: если overlay ещё не получил размеры (первый кадр после show),
        // пропускаем — drawImage на 0×0 canvas бросает DOMException.
        if (cw === 0 || ch === 0) return;

        this.initWorldDims();
        this.renderWorldImage(); // пересобирает при dirty флаге

        let dpr = Math.min(window.devicePixelRatio || 1, 2);

        if (this.canvas.width !== cw * dpr || this.canvas.height !== ch * dpr) {
            this.canvas.width = cw * dpr;
            this.canvas.height = ch * dpr;
        }

        let ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        // Фон
        ctx.fillStyle = 'rgb(8, 9, 14)';
        ctx.fillRect(0, 0, cw, ch);

        if (!this.worldImage) return;

        // Отрисовка мира
        ctx.imageSmoothingEnabled = false;
        ctx.save();
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);
        ctx.drawImage(this.worldImage, 0, 0);
        ctx.restore();

        this.drawPlayerMarker(ctx);
        this.drawGridBorders(ctx);
        this.updateStats();
    }

    private drawPlayerMarker(ctx: CanvasRenderingContext2D): void {
        let player = this.game.player;
        if (!player) return;

        let tx = player.gridX,
            ty = player.gridY;

        if (tx !== this.lastPlayerTile.x || ty !== this.lastPlayerTile.y) {
            this.lastPlayerTile = { x: tx, y: ty };
        }

        let sx = this.offsetX + tx * this.scale,
            sy = this.offsetY + ty * this.scale;

        this.pulsePhase = (this.pulsePhase + 0.08) % (Math.PI * 2);
        let pulse = 0.6 + 0.4 * Math.abs(Math.sin(this.pulsePhase)),
            baseRadius = Math.max(3, this.scale * 0.5);

        // Внешний halo
        ctx.fillStyle = `rgba(255, 82, 82, ${0.15 * pulse})`;
        ctx.beginPath();
        ctx.arc(sx, sy, baseRadius * 3, 0, Math.PI * 2);
        ctx.fill();

        // Центр
        ctx.fillStyle = '#ff5252';
        ctx.beginPath();
        ctx.arc(sx, sy, baseRadius, 0, Math.PI * 2);
        ctx.fill();

        // Обводка
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    private drawGridBorders(ctx: CanvasRenderingContext2D): void {
        // Бордюр карты (чтобы видеть границы мира)
        ctx.strokeStyle = 'rgba(150, 180, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(
            this.offsetX - 0.5,
            this.offsetY - 0.5,
            this.worldTiles * this.scale + 1,
            this.worldTilesH * this.scale + 1
        );
    }

    private updateStats(): void {
        let discovered = this.discoveredRegions.size,
            total = this.totalRegions || 1,
            percent = Math.round((discovered / total) * 100);

        this.statsEl.textContent = `Исследовано: ${discovered}/${total} (${percent}%)`;
    }

    private loop(): void {
        this.render();
        this.rafId = requestAnimationFrame(() => this.loop());
    }

    // ─────────────────────────────────────────────────────────────
    // Камера
    // ─────────────────────────────────────────────────────────────

    private centerOnPlayer(): void {
        this.initWorldDims();

        let cw = this.canvas.clientWidth || 800,
            ch = this.canvas.clientHeight || 600,
            player = this.game.player;

        // По умолчанию — подогнать карту по меньшей стороне
        let fitScale = Math.min(cw / this.worldTiles, ch / this.worldTilesH) * 0.85;
        this.scale = Math.max(this.minScale, Math.min(this.maxScale, fitScale));

        if (player) {
            this.offsetX = cw / 2 - player.gridX * this.scale;
            this.offsetY = ch / 2 - player.gridY * this.scale;
        } else {
            this.offsetX = cw / 2 - (this.worldTiles * this.scale) / 2;
            this.offsetY = ch / 2 - (this.worldTilesH * this.scale) / 2;
        }
    }

    private clampOffsets(): void {
        let cw = this.canvas.clientWidth,
            ch = this.canvas.clientHeight,
            mapW = this.worldTiles * this.scale,
            mapH = this.worldTilesH * this.scale,
            margin = Math.min(cw, ch) * 0.5;

        // Не даём полностью увести карту за края
        this.offsetX = Math.min(cw - margin, Math.max(margin - mapW, this.offsetX));
        this.offsetY = Math.min(ch - margin, Math.max(margin - mapH, this.offsetY));
    }

    private zoomAt(anchorX: number, anchorY: number, factor: number): void {
        let newScale = this.scale * factor;
        newScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

        let effectiveFactor = newScale / this.scale;

        this.offsetX = anchorX - (anchorX - this.offsetX) * effectiveFactor;
        this.offsetY = anchorY - (anchorY - this.offsetY) * effectiveFactor;
        this.scale = newScale;

        this.clampOffsets();
    }

    // ─────────────────────────────────────────────────────────────
    // События ввода
    // ─────────────────────────────────────────────────────────────

    private bindEvents(): void {
        this.canvas.addEventListener('pointerdown', this.onPointerDown.bind(this));
        this.canvas.addEventListener('pointermove', this.onPointerMove.bind(this));
        this.canvas.addEventListener('pointerup', this.onPointerUp.bind(this));
        this.canvas.addEventListener('pointercancel', this.onPointerUp.bind(this));
        this.canvas.addEventListener('pointerleave', this.onPointerUp.bind(this));
        this.canvas.addEventListener(
            'wheel',
            (e) => {
                e.preventDefault();
                let rect = this.canvas.getBoundingClientRect(),
                    ax = e.clientX - rect.left,
                    ay = e.clientY - rect.top,
                    factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
                this.zoomAt(ax, ay, factor);
            },
            { passive: false }
        );

        // Esc закрывает
        document.addEventListener('keydown', (e) => {
            if (!this.isVisible()) return;
            if (e.code === 'Escape') this.hide();
        });
    }

    private onPointerDown(e: PointerEvent): void {
        this.canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.pointers.size === 1) {
            this.dragging = true;
            this.dragPointerId = e.pointerId;
            this.lastPointerX = e.clientX;
            this.lastPointerY = e.clientY;
        } else if (this.pointers.size === 2) {
            this.dragging = false;
            let pts = [...this.pointers.values()];
            let dx = pts[0].x - pts[1].x,
                dy = pts[0].y - pts[1].y;
            this.pinchStartDist = Math.hypot(dx, dy);
            this.pinchStartScale = this.scale;

            let rect = this.canvas.getBoundingClientRect();
            this.pinchAnchor = {
                x: (pts[0].x + pts[1].x) / 2 - rect.left,
                y: (pts[0].y + pts[1].y) / 2 - rect.top
            };
        }
    }

    private onPointerMove(e: PointerEvent): void {
        if (!this.pointers.has(e.pointerId)) return;

        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.pointers.size === 1 && this.dragging && e.pointerId === this.dragPointerId) {
            let dx = e.clientX - this.lastPointerX,
                dy = e.clientY - this.lastPointerY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastPointerX = e.clientX;
            this.lastPointerY = e.clientY;
            this.clampOffsets();
        } else if (this.pointers.size === 2) {
            let pts = [...this.pointers.values()];
            let dx = pts[0].x - pts[1].x,
                dy = pts[0].y - pts[1].y,
                dist = Math.hypot(dx, dy);

            if (this.pinchStartDist > 0) {
                let targetScale = this.pinchStartScale * (dist / this.pinchStartDist);
                let factor = targetScale / this.scale;
                this.zoomAt(this.pinchAnchor.x, this.pinchAnchor.y, factor);
            }
        }
    }

    private onPointerUp(e: PointerEvent): void {
        // Освобождаем capture, если он был запрошен в onPointerDown.
        // Без этого жест может "залипнуть" если pointer вышел за canvas аномально.
        if (this.canvas.hasPointerCapture?.(e.pointerId)) {
            this.canvas.releasePointerCapture(e.pointerId);
        }

        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.pinchStartDist = 0;
        if (this.pointers.size === 0) {
            this.dragging = false;
            this.dragPointerId = null;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Overrides Menu lifecycle
    // ─────────────────────────────────────────────────────────────

    public override show(): void {
        super.show();
        this.initWorldDims();

        // Гарантируем DPR-синхронный canvas ДО первого центрирования
        let cw = this.canvas.clientWidth,
            ch = this.canvas.clientHeight;
        if (cw === 0 || ch === 0) {
            // Forced reflow — overlay только что вставили, размеры ещё 0
            requestAnimationFrame(() => this.centerOnPlayer());
        } else {
            this.centerOnPlayer();
        }

        this.worldImageDirty = true;

        if (!this.rafId) this.loop();

        log.info('WorldMap opened');
    }

    public override hide(): void {
        super.hide();
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = 0;
        }
    }

    public override resize(): void {
        // Canvas использует client* → пересчитается сам на следующий кадр
        this.worldImageDirty = true;
    }
}
