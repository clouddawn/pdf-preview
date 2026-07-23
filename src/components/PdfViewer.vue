<template>
  <div class="pdf-viewer">
    <!-- ========== 顶部工具栏 ========== -->
    <header class="pdf-viewer__toolbar">
      <!-- 左侧：文件加载 -->
      <div class="toolbar__left">
        <input
          ref="fileInputRef"
          type="file"
          accept=".pdf,application/pdf"
          class="toolbar__file-input"
          @change="handleFileChange"
        />
        <button class="toolbar__btn toolbar__btn--primary" @click="openFilePicker">
          <span class="btn__icon">📂</span>
          <span>选择PDF</span>
        </button>
        <span v-if="fileName" class="toolbar__filename">{{ fileName }}</span>
      </div>

      <!-- 中间：页面导航 -->
      <div class="toolbar__center">
        <button
          class="toolbar__btn"
          :disabled="!isLoaded || currentPage <= 1"
          @click="handlePrevPage"
          title="上一页"
        >
          ← 上一页
        </button>

        <div class="toolbar__page-info">
          <input
            class="page-info__input"
            type="number"
            :value="currentPage"
            :min="1"
            :max="totalPages"
            :disabled="!isLoaded"
            @change="handlePageInput"
          />
          <span class="page-info__separator">/</span>
          <span class="page-info__total">{{ totalPages || '-' }}</span>
        </div>

        <button
          class="toolbar__btn"
          :disabled="!isLoaded || currentPage >= totalPages"
          @click="handleNextPage"
          title="下一页"
        >
          下一页 →
        </button>
      </div>

      <!-- 右侧：缩放控制 + 模式切换 -->
      <div class="toolbar__right">
        <button class="toolbar__btn" :disabled="!isLoaded" @click="zoomOut" title="缩小">
          🔍-
        </button>
        <span class="toolbar__scale-label">{{ Math.round(scale * 100) }}%</span>
        <button class="toolbar__btn" :disabled="!isLoaded" @click="zoomIn" title="放大">
          🔍+
        </button>
        <button class="toolbar__btn" :disabled="!isLoaded" @click="fitToWidth" title="适应宽度">
          ↔ 适应
        </button>

        <!-- 模式切换 -->
        <span class="toolbar__divider"></span>
        <button
          class="toolbar__btn toolbar__btn--mode"
          :disabled="!isLoaded"
          :title="isScrollMode ? '切换到单页模式' : '切换到滚动模式'"
          @click="toggleViewMode"
        >
          {{ isScrollMode ? '📜 滚动' : '📄 单页' }}
        </button>
      </div>
    </header>

    <!-- ========== Canvas 渲染区域 ========== -->
    <main
      class="pdf-viewer__canvas-area"
      :class="{ 'pdf-viewer__canvas-area--scroll': isScrollMode }"
      @dragover.prevent
      @drop.prevent="handleDrop"
    >
      <!-- 未加载状态 -->
      <div v-if="!isLoaded && !isLoading" class="canvas-area__placeholder">
        <div class="placeholder__icon">📄</div>
        <p class="placeholder__text">点击「选择PDF」或拖拽 PDF 文件到此处</p>
        <button class="placeholder__btn" @click="openFilePicker">选择文件</button>
      </div>

      <!-- 加载中 -->
      <div v-if="isLoading" class="canvas-area__loading">
        <div class="loading__spinner"></div>
        <p>正在加载 PDF...</p>
      </div>

      <!-- 错误提示 -->
      <div v-if="error" class="canvas-area__error">
        <p class="error__icon">⚠️</p>
        <p class="error__text">{{ error }}</p>
      </div>

      <!-- ===== 滚动模式：全部页面垂直堆叠 ===== -->
      <div
        v-if="isLoaded && !error && isScrollMode"
        ref="scrollContainerRef"
        class="scroll-container"
        @scroll.passive="handleScroll"
      >
        <div
          v-for="i in totalPages"
          :key="i"
          class="scroll__page"
          :data-page="i"
        >
          <canvas
            :ref="(el: any) => setCanvasRef(i, el as HTMLCanvasElement)"
            class="scroll__canvas"
          ></canvas>
          <span class="scroll__page-label">第 {{ i }} 页</span>
        </div>
      </div>

      <!-- ===== 单页模式（原有逻辑） ===== -->
      <canvas
        v-if="isLoaded && !error && !isScrollMode"
        ref="canvasRef"
        class="canvas-area__canvas"
      ></canvas>
    </main>

    <!-- ========== 底部状态栏 ========== -->
    <footer class="pdf-viewer__statusbar">
      <span v-if="isLoaded">
        已加载 · {{ totalPages }} 页 · {{ isScrollMode ? '滚动模式' : '单页模式' }} · 缩放 {{ Math.round(scale * 100) }}%
      </span>
      <span v-else-if="isLoading">加载中...</span>
      <span v-else>就绪</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, type Ref } from 'vue'
import { usePdfRenderer } from '@/composables/usePdfRenderer'

// ========== PDF 渲染器 ==========
const {
  canvasRef,
  currentPage,
  totalPages,
  scale,
  isLoading,
  error,
  isLoaded,
  fileName,
  isScrollMode,
  loadPdf,
  renderAllPages,
  prevPage,
  nextPage,
  goToPage,
  zoomIn,
  zoomOut,
  fitToWidth,
  toggleViewMode,
  setCanvasRef,
  updateVisiblePage,
  scrollToPage,
} = usePdfRenderer()

// ========== 滚动容器 ref ==========
const scrollContainerRef: Ref<HTMLElement | null> = ref(null)

// ========== 文件输入 ==========
const fileInputRef: Ref<HTMLInputElement | null> = ref(null)

function openFilePicker(): void {
  fileInputRef.value?.click()
}

function handleFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  readAndLoadFile(file)
  input.value = ''
}

function handleDrop(event: DragEvent): void {
  const file = event.dataTransfer?.files?.[0]
  if (!file || file.type !== 'application/pdf') return
  readAndLoadFile(file)
}

function readAndLoadFile(file: File): void {
  const reader = new FileReader()
  reader.onload = (e) => {
    const buffer = e.target?.result
    if (buffer instanceof ArrayBuffer) {
      loadPdf(buffer, file.name)
    }
  }
  reader.onerror = () => {
    error.value = '文件读取失败'
  }
  reader.readAsArrayBuffer(file)
}

// ========== 页面导航 ==========

function handlePrevPage(): void {
  if (isScrollMode.value) {
    const el = scrollContainerRef.value
    if (el && currentPage.value > 1) {
      scrollToPage(currentPage.value - 1, el)
    }
  } else {
    prevPage()
  }
}

function handleNextPage(): void {
  if (isScrollMode.value) {
    const el = scrollContainerRef.value
    if (el && currentPage.value < totalPages.value) {
      scrollToPage(currentPage.value + 1, el)
    }
  } else {
    nextPage()
  }
}

function handlePageInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const page = parseInt(input.value, 10)
  if (!isNaN(page)) {
    if (isScrollMode.value) {
      const el = scrollContainerRef.value
      if (el) {
        scrollToPage(page, el)
        return
      }
    }
    goToPage(page)
  } else {
    input.value = String(currentPage.value)
  }
}

// ========== 滚动监听 ==========

let scrollTimer: ReturnType<typeof setTimeout> | null = null

function handleScroll(): void {
  const el = scrollContainerRef.value
  if (!el) return

  // 防抖 100ms
  if (scrollTimer) clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => {
    updateVisiblePage(el)
  }, 100)
}
</script>

<style lang="less" scoped>
/* ========== 变量 ========== */
@toolbar-height: 52px;
@statusbar-height: 32px;
@border-color: #e0e0e0;
@primary: #1890ff;
@primary-hover: #40a9ff;
@btn-bg: #fafafa;
@btn-hover-bg: #e6f7ff;
@btn-disabled-bg: #f5f5f5;
@btn-disabled-color: #bfbfbf;

/* ========== 容器 ========== */
.pdf-viewer {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f5f5f5;
}

/* ========== 工具栏 ========== */
.pdf-viewer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: @toolbar-height;
  padding: 0 16px;
  background: #fff;
  border-bottom: 1px solid @border-color;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  z-index: 10;
  gap: 12px;
  flex-shrink: 0;
}

.toolbar__left,
.toolbar__center,
.toolbar__right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar__center {
  gap: 6px;
}

.toolbar__file-input {
  display: none;
}

.toolbar__filename {
  font-size: 13px;
  color: #666;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: 4px;
}

.toolbar__divider {
  width: 1px;
  height: 20px;
  background: #d9d9d9;
  margin: 0 4px;
}

/* ========== 按钮 ========== */
.toolbar__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  background: @btn-bg;
  color: #333;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s ease;
  user-select: none;

  &:hover:not(:disabled) {
    background: @btn-hover-bg;
    border-color: @primary;
    color: @primary;
  }

  &:active:not(:disabled) {
    background: #bae7ff;
  }

  &:disabled {
    background: @btn-disabled-bg;
    color: @btn-disabled-color;
    cursor: not-allowed;
  }
}

.toolbar__btn--primary {
  background: @primary;
  border-color: @primary;
  color: #fff;

  &:hover:not(:disabled) {
    background: @primary-hover;
    border-color: @primary-hover;
    color: #fff;
  }

  &:active:not(:disabled) {
    background: #096dd9;
  }
}

.toolbar__btn--mode {
  font-weight: 500;
}

.btn__icon {
  font-size: 14px;
}

/* ========== 页面信息 ========== */
.toolbar__page-info {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

.page-info__input {
  width: 42px;
  height: 28px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  text-align: center;
  font-size: 13px;
  color: #333;
  outline: none;

  &:focus {
    border-color: @primary;
    box-shadow: 0 0 0 2px rgba(24, 144, 255, 0.2);
  }

  &:disabled {
    background: #f5f5f5;
    color: #bfbfbf;
  }

  &::-webkit-inner-spin-button,
  &::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  -moz-appearance: textfield;
}

.page-info__separator {
  color: #999;
}

.page-info__total {
  min-width: 20px;
  text-align: center;
  color: #666;
}

/* ========== 缩放 ========== */
.toolbar__scale-label {
  font-size: 13px;
  color: #666;
  min-width: 40px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* ========== Canvas 区域 ========== */
.pdf-viewer__canvas-area {
  flex: 1;
  overflow: auto;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 24px;
  background: #e8e8e8;
  background-image:
    linear-gradient(45deg, #ddd 25%, transparent 25%),
    linear-gradient(-45deg, #ddd 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #ddd 75%),
    linear-gradient(-45deg, transparent 75%, #ddd 75%);
  background-size: 20px 20px;
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
}

/* 滚动模式下隐藏外层滚动条，由内层 scroll-container 处理 */
.pdf-viewer__canvas-area--scroll {
  overflow: hidden;
  padding: 0;
}

.canvas-area__canvas {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  background: #fff;
  display: block;
}

/* ========== 滚动模式 ========== */
.scroll-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 24px;
  scroll-behavior: smooth;

  /* 也为滚动容器添加棋盘格背景 */
  background: #e8e8e8;
  background-image:
    linear-gradient(45deg, #ddd 25%, transparent 25%),
    linear-gradient(-45deg, #ddd 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #ddd 75%),
    linear-gradient(-45deg, transparent 75%, #ddd 75%);
  background-size: 20px 20px;
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
}

.scroll__page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.scroll__canvas {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  background: #fff;
  display: block;
}

.scroll__page-label {
  font-size: 12px;
  color: #999;
  user-select: none;
}

/* ========== 占位状态 ========== */
.canvas-area__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 80px 20px;
  color: #999;
}

.placeholder__icon {
  font-size: 64px;
  opacity: 0.4;
}

.placeholder__text {
  font-size: 15px;
}

.placeholder__btn {
  padding: 8px 24px;
  border: 2px dashed #d9d9d9;
  border-radius: 6px;
  background: #fff;
  color: @primary;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    border-color: @primary;
    border-style: solid;
    background: @btn-hover-bg;
  }
}

/* ========== 加载状态 ========== */
.canvas-area__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 80px 20px;
  color: #666;
}

.loading__spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #e8e8e8;
  border-top-color: @primary;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ========== 错误状态 ========== */
.canvas-area__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 80px 20px;
}

.error__icon {
  font-size: 48px;
}

.error__text {
  font-size: 14px;
  color: #ff4d4f;
  max-width: 400px;
  text-align: center;
  word-break: break-word;
}

/* ========== 底部状态栏 ========== */
.pdf-viewer__statusbar {
  display: flex;
  align-items: center;
  height: @statusbar-height;
  padding: 0 16px;
  background: #fff;
  border-top: 1px solid @border-color;
  font-size: 12px;
  color: #999;
  flex-shrink: 0;
}

/* ========== 响应式 ========== */
@media (max-width: 768px) {
  .pdf-viewer__toolbar {
    flex-wrap: wrap;
    height: auto;
    padding: 8px 10px;
    gap: 6px;
  }

  .toolbar__left,
  .toolbar__center,
  .toolbar__right {
    flex: 1;
    min-width: 0;
    justify-content: center;
  }

  .toolbar__filename {
    max-width: 100px;
  }

  .pdf-viewer__canvas-area {
    padding: 12px;
  }

  .pdf-viewer__canvas-area--scroll {
    padding: 0;
  }

  .scroll-container {
    padding: 12px;
    gap: 12px;
  }

  .toolbar__divider {
    display: none;
  }
}
</style>
