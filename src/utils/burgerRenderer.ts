/**
 * Frame Manager & Canvas Renderer for SMASH & SONS "THE BUILD" Section
 * Handles:
 * - 30-frame sequence targeting `/assets/frames/burger_%04d.webp` (frames 1 to 30)
 * - Immediate preloading of first 10 frames
 * - Lazy background loading of remaining frames
 * - Canvas cover-fit calculation on window resize with devicePixelRatio support
 * - Dynamic frame-blending with safe viewport padding
 */

export interface FrameStatus {
  totalFrames: number;
  loadedFrames: number;
  hasCustomFrames: boolean;
  isLoading: boolean;
}

export class BurgerFrameManager {
  private totalFrames: number = 30;
  private images: (HTMLImageElement | null)[] = [];
  private imageStatus: ('empty' | 'loading' | 'loaded' | 'error')[] = [];
  private hasCustomFrames: boolean = false;
  private onProgressCallback?: (status: FrameStatus) => void;
  private isDestroyed: boolean = false;
  private lazyBatchIndex: number = 11;

  constructor(onProgress?: (status: FrameStatus) => void) {
    this.onProgressCallback = onProgress;
    this.images = new Array(this.totalFrames).fill(null);
    this.imageStatus = new Array(this.totalFrames).fill('empty');
  }

  /**
   * Formats 1-based index into burger_%04d.webp
   * Example: 1 -> /assets/frames/burger_0001.webp
   */
  public getFramePath(index1Based: number): string {
    const padded = String(index1Based).padStart(4, '0');
    return `/assets/frames/burger_${padded}.webp`;
  }

  /**
   * Preload the first 10 frames immediately, then lazily queue the rest.
   */
  public init() {
    this.preloadInitialFrames(10);
  }

  private preloadInitialFrames(count: number) {
    const limit = Math.min(count, this.totalFrames);
    for (let i = 1; i <= limit; i++) {
      this.loadSingleFrame(i, () => {
        // Once first 10 frames have been attempted, start lazy loading remaining frames in idle time
        if (i === limit && !this.isDestroyed) {
          this.scheduleLazyLoad();
        }
      });
    }
  }

  private scheduleLazyLoad() {
    if (this.lazyBatchIndex > this.totalFrames || this.isDestroyed) return;

    const loadNextBatch = () => {
      const batchSize = 6;
      const end = Math.min(this.lazyBatchIndex + batchSize, this.totalFrames + 1);
      for (let i = this.lazyBatchIndex; i < end; i++) {
        this.loadSingleFrame(i);
      }
      this.lazyBatchIndex = end;

      if (this.lazyBatchIndex <= this.totalFrames && !this.isDestroyed) {
        if ('requestIdleCallback' in window) {
          (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(loadNextBatch);
        } else {
          setTimeout(loadNextBatch, 80);
        }
      }
    };

    setTimeout(loadNextBatch, 150);
  }

  private loadSingleFrame(frameNum: number, onComplete?: () => void) {
    const idx = frameNum - 1;
    if (this.imageStatus[idx] !== 'empty') {
      onComplete?.();
      return;
    }

    this.imageStatus[idx] = 'loading';
    const img = new Image();
    const src = this.getFramePath(frameNum);
    img.src = src;

    img.onload = () => {
      if (this.isDestroyed) return;
      this.images[idx] = img;
      this.imageStatus[idx] = 'loaded';
      this.hasCustomFrames = true;
      this.notifyProgress();
      onComplete?.();
    };

    img.onerror = () => {
      if (this.isDestroyed) return;
      this.images[idx] = null;
      this.imageStatus[idx] = 'error';
      this.notifyProgress();
      onComplete?.();
    };
  }

  private notifyProgress() {
    if (!this.onProgressCallback) return;
    const loadedCount = this.imageStatus.filter(s => s === 'loaded').length;
    this.onProgressCallback({
      totalFrames: this.totalFrames,
      loadedFrames: loadedCount,
      hasCustomFrames: this.hasCustomFrames,
      isLoading: this.lazyBatchIndex <= this.totalFrames
    });
  }

  public getFrame(index1Based: number): HTMLImageElement | null {
    const clamped = Math.max(1, Math.min(this.totalFrames, Math.round(index1Based)));
    const img = this.images[clamped - 1];
    if (img && this.imageStatus[clamped - 1] === 'loaded') {
      return img;
    }
    return null;
  }

  public destroy() {
    this.isDestroyed = true;
    this.images = [];
  }

  /**
   * Cover-fits image on the canvas with Retina / DPR scaling
   */
  public draw(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    frameIndex1Based: number,
    _progress: number // 0 to 1
  ) {
    const width = canvas.width;
    const height = canvas.height;

    // Fill charcoal background void
    ctx.fillStyle = '#0E0E0E';
    ctx.fillRect(0, 0, width, height);

    // Frame Interpolation Math for Slow-Scroll Stutter Elimination
    const clampedFloat = Math.max(1, Math.min(this.totalFrames, frameIndex1Based));
    const frameA = Math.floor(clampedFloat);
    const frameB = Math.min(this.totalFrames, frameA + 1);
    const delta = clampedFloat - frameA;

    // Hermite smoothstep curve: 3t^2 - 2t^3 gives natural optical persistence of vision
    const blendAlpha = delta * delta * (3 - 2 * delta);

    const imgA = this.getFrame(frameA);
    const imgB = frameB !== frameA ? this.getFrame(frameB) : null;

    if ((imgA && imgA.naturalWidth > 0) || (imgB && imgB.naturalWidth > 0)) {
      const primaryImg = imgA || imgB!;
      const SAFE_SCALE = 0.85;
      const imgRatio = primaryImg.naturalWidth / primaryImg.naturalHeight;
      const canvasRatio = width / height;
      let drawW: number;
      let drawH: number;

      if (canvasRatio > imgRatio) {
        drawH = height * SAFE_SCALE;
        drawW = drawH * imgRatio;
      } else {
        drawW = width * SAFE_SCALE;
        drawH = drawW / imgRatio;
      }

      const offsetX = (width - drawW) / 2;
      const offsetY = (height - drawH) / 2;

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const hasCurrent = imgA && imgA.naturalWidth > 0;
      const hasNext = imgB && imgB.naturalWidth > 0;

      // Frame-blending: render current and next frames with globalAlpha transparency
      // during transitions, creating a smoother optical motion-blur feel between steps
      if (hasCurrent && hasNext && blendAlpha > 0.001) {
        // 1. Render current frame with (1 - blendAlpha) transparency
        ctx.globalAlpha = 1.0 - blendAlpha;
        ctx.drawImage(imgA, offsetX, offsetY, drawW, drawH);

        // 2. Render next frame with blendAlpha transparency
        ctx.globalAlpha = blendAlpha;
        ctx.drawImage(imgB, offsetX, offsetY, drawW, drawH);
      } else if (hasCurrent) {
        // Single frame fallback (exact integer milestone or next frame pending)
        ctx.globalAlpha = 1.0;
        ctx.drawImage(imgA, offsetX, offsetY, drawW, drawH);
      } else if (hasNext) {
        ctx.globalAlpha = 1.0;
        ctx.drawImage(imgB, offsetX, offsetY, drawW, drawH);
      }

      ctx.restore();
    }
  }

  /**
   * Explicit public interpolation drawer for micro-scroll blending
   */
  public drawInterpolated(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    frameFloat: number,
    progress: number
  ) {
    this.draw(ctx, canvas, frameFloat, progress);
  }
}
