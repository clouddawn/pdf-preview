import { ref, watch, computed, onUnmounted, shallowReactive, nextTick as vueNextTick } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'

// 配置 PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

/** 查看模式 */
export type ViewMode = 'single' | 'scroll'

/** 滚动模式下同时渲染的最大页数 */
const SCROLL_CONCURRENCY = 3

/** PDF 文本项（匹配 pdfjs-dist 的 TextItem 结构） */
export interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

/** 页面文本提取结果 */
export interface PageTextResult {
  items: PdfTextItem[]
  /** 未缩放的页面宽度（scale=1 时的 viewport 宽度） */
  pageWidth: number
  /** 未缩放的页面高度（scale=1 时的 viewport 高度） */
  pageHeight: number
}

export function usePdfRenderer() {
  // ========== 状态 ==========
  /** 单页模式的 canvas ref */
  const canvasRef = ref<HTMLCanvasElement | null>(null)
  /** 滚动模式下各页的 canvas refs。使用 shallowReactive 包裹 Map：
   *  - Map 的 set/delete 操作会触发响应式通知（Vue 3 对集合类型有特殊处理）
   *  - shallow 确保存入的 HTMLCanvasElement 不会被深度代理，避免性能开销
   *  注意：当前没有 computed/watch 直接依赖 canvasRefs，仅通过命令式 .get() 访问 */
  const canvasRefs = shallowReactive<Map<number, HTMLCanvasElement>>(new Map())
  const currentPage = ref(1)
  const totalPages = ref(0)
  const scale = ref(1.0)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const isLoaded = ref(false)
  const fileName = ref('')
  const isFitWidth = ref(false)
  /** 查看模式：默认滚动模式 */
  const viewMode = ref<ViewMode>('scroll')

  // 计算属性
  const isScrollMode = computed(() => viewMode.value === 'scroll')
  const isSingleMode = computed(() => viewMode.value === 'single')

  // ========== 内部变量 ==========
  let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null
  /** 活跃的渲染任务集合（支持并发渲染） */
  const activeRenderTasks = new Set<pdfjsLib.RenderTask>()
  let currentPageProxy: pdfjsLib.PDFPageProxy | null = null
  /** 已渲染过的页码（避免重复渲染） */
  const renderedPages = new Set<number>()
  /** 渲染代数计数器，用于取消过时的异步渲染 */
  let renderGeneration = 0
  /** 缓存第一页的未缩放宽度，避免 fitToWidth 重复 fetch 整页 */
  let firstPageUnscaledWidth: number | null = null

  // ========== 核心渲染方法 ==========

  /**
   * 渲染核心：获取页面 → 缓存宽度 → HiDPI 计算 → 渲染到 Canvas
   *
   * 调用方通过返回值区分成功/过期：
   * - 返回 PDFPageProxy：渲染成功，调用方负责决定是否 cleanup
   * - 返回 null：代际过期或文档已关闭，调用方应直接退出
   *
   * 注意：本方法不调用 cancelRender()，由外层调用方在合适的时机调用。
   */
  async function renderPageCore(
    pageNum: number,
    canvas: HTMLCanvasElement,
    gen: number,
  ): Promise<pdfjsLib.PDFPageProxy | null> {
    if (!pdfDoc) return null
    if (gen !== renderGeneration) return null

    let page: pdfjsLib.PDFPageProxy | null = null
    try {
      page = await pdfDoc.getPage(pageNum)
      if (gen !== renderGeneration) { page.cleanup(); return null }

      // 缓存第一页的未缩放宽度
      if (pageNum === 1 && firstPageUnscaledWidth === null) {
        firstPageUnscaledWidth = page.getViewport({ scale: 1 }).width
      }

      // HiDPI 高清渲染
      const pixelRatio = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: scale.value * pixelRatio })

      const ctx = canvas.getContext('2d')!
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`
      canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`

      const task = page.render({ canvasContext: ctx, viewport })
      activeRenderTasks.add(task)
      try {
        await task.promise
      } finally {
        activeRenderTasks.delete(task)
      }

      if (gen !== renderGeneration) { page.cleanup(); return null }
      return page
    } catch (e: unknown) {
      if (page) page.cleanup()
      throw e
    }
  }

  /** 将指定页渲染到目标 Canvas，页面资源用完即弃（滚动模式专用） */
  async function renderPageToCanvas(
    pageNum: number,
    canvas: HTMLCanvasElement,
    gen: number,
  ): Promise<void> {
    const page = await renderPageCore(pageNum, canvas, gen)
    if (page) page.cleanup()
  }

  /** 渲染当前页到单页 Canvas */
  async function renderCurrentPage(): Promise<void> {
    const canvas = canvasRef.value
    if (!canvas || !pdfDoc) return

    cleanupPage()
    cancelRender() // 取消上一次单页渲染任务
    error.value = null

    const gen = ++renderGeneration
    const pageNum = currentPage.value

    try {
      const page = await renderPageCore(pageNum, canvas, gen)
      if (!page) {
        // 仅在当前代际有效时才清理，避免误伤新代际已设置的 currentPageProxy
        if (gen === renderGeneration) cleanupPage()
        return
      }
      // 单页模式下保留 page proxy 引用，由 cleanupPage() 统一清理
      currentPageProxy = page
    } catch (e: unknown) {
      // 代际过期：静默退出，不触碰任何共享状态（currentPageProxy 可能已被新代际占用）
      if (gen !== renderGeneration) return
      cleanupPage()
      if (e instanceof Error && (e.message?.includes('cancelled') || e.name === 'RenderingCancelledException')) {
        return
      }
      error.value = `渲染失败: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // ========== 滚动模式渲染 ==========

  /** 滚动模式：渲染全部页面（有限并发） */
  async function renderAllPages(): Promise<void> {
    if (!pdfDoc) return

    cancelRender()
    cleanupPage()
    renderedPages.clear()
    error.value = null

    const gen = ++renderGeneration
    const pageCount = pdfDoc.numPages

    for (let i = 1; i <= pageCount; i += SCROLL_CONCURRENCY) {
      if (gen !== renderGeneration) return

      const batch: Promise<void>[] = []
      for (let j = i; j < Math.min(i + SCROLL_CONCURRENCY, pageCount + 1); j++) {
        batch.push(renderOneScrollPage(j, gen))
      }
      await Promise.all(batch)
    }
  }

  /** 滚动模式：渲染单页（含 canvas 获取与错误处理） */
  async function renderOneScrollPage(pageNum: number, gen: number): Promise<void> {
    if (gen !== renderGeneration) return

    let canvas = canvasRefs.get(pageNum)
    if (!canvas) {
      await nextTick()
      if (gen !== renderGeneration) return
      canvas = canvasRefs.get(pageNum)
      if (!canvas) {
        if (gen !== renderGeneration) return
        error.value = `第 ${pageNum} 页渲染失败：canvas 未就绪`
        return
      }
    }

    if (renderedPages.has(pageNum)) return

    try {
      await renderPageToCanvas(pageNum, canvas, gen)
      if (gen !== renderGeneration) return
      renderedPages.add(pageNum)
    } catch (e: unknown) {
      if (e instanceof Error && (e.message?.includes('cancelled') || e.name === 'RenderingCancelledException')) {
        return
      }
      if (gen !== renderGeneration) return
      error.value = `第 ${pageNum} 页渲染失败: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  /**
   * 等待 Vue DOM 更新后再等浏览器完成一帧布局
   * 相比双层 rAF（~32ms），vueNextTick + 单层 rAF 降至 ~16ms
   */
  function nextTick(): Promise<void> {
    return vueNextTick().then(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => resolve())
    }))
  }

  /** 从 ArrayBuffer 加载 PDF */
  async function loadPdf(data: ArrayBuffer, name = ''): Promise<void> {
    cancelRender()
    cleanupPage()
    renderedPages.clear()
    firstPageUnscaledWidth = null
    // 递增渲染代数，让所有进行中的旧渲染通过 gen 检查自动退出
    renderGeneration++
    if (pdfDoc) {
      await pdfDoc.destroy()
      pdfDoc = null
    }

    isLoading.value = true
    error.value = null
    isLoaded.value = false
    fileName.value = name

    try {
      const loadingTask = pdfjsLib.getDocument({ data })
      pdfDoc = await loadingTask.promise
      totalPages.value = pdfDoc.numPages
      currentPage.value = 1
      isLoaded.value = true

      // 根据当前模式渲染
      if (isScrollMode.value) {
        await renderAllPages()
      } else {
        await renderCurrentPage()
      }
    } catch (e) {
      pdfDoc = null
      const msg = e instanceof Error ? e.message : 'PDF 加载失败'
      error.value = `加载失败: ${msg}`
    } finally {
      isLoading.value = false
    }
  }

  /** 获取指定页的文本内容和页面尺寸（供搜索功能使用） */
  async function getPageTextContent(pageNum: number): Promise<PageTextResult | null> {
    if (!pdfDoc) return null
    try {
      const page = await pdfDoc.getPage(pageNum)
      const unscaledViewport = page.getViewport({ scale: 1 })
      const textContent = await page.getTextContent()
      page.cleanup()
      // 提取文本项（过滤掉 TextMarkedContent）
      const items: PdfTextItem[] = []
      for (const item of textContent.items) {
        if ('str' in item) {
          items.push({ str: item.str, transform: item.transform, width: item.width, height: item.height })
        }
      }
      return {
        items,
        pageWidth: unscaledViewport.width,
        pageHeight: unscaledViewport.height,
      }
    } catch {
      return null
    }
  }

  /** 取消所有活跃的渲染任务 */
  function cancelRender(): void {
    for (const task of activeRenderTasks) {
      try { task.cancel() } catch { /* 忽略取消失败 */ }
    }
    activeRenderTasks.clear()
  }

  /** 清理当前页面资源 */
  function cleanupPage(): void {
    if (currentPageProxy) {
      currentPageProxy.cleanup()
      currentPageProxy = null
    }
  }

  // ========== 页面导航 ==========

  function prevPage(): void {
    if (currentPage.value > 1) {
      currentPage.value--
    }
  }

  function nextPage(): void {
    if (currentPage.value < totalPages.value) {
      currentPage.value++
    }
  }

  function goToPage(pageNum: number): void {
    if (pageNum >= 1 && pageNum <= totalPages.value) {
      currentPage.value = pageNum
    }
  }

  // ========== 滚动模式下，根据 scrollTop 更新当前可见页 ==========

  function updateVisiblePage(containerEl: HTMLElement): void {
    if (!isLoaded.value || totalPages.value === 0) return

    const scrollTop = containerEl.scrollTop
    const containerHeight = containerEl.clientHeight
    const viewCenter = scrollTop + containerHeight / 2

    let bestPage = currentPage.value
    let bestDistance = Infinity

    // 遍历所有页的 canvas 容器，找最接近视口中心的页
    for (let i = 1; i <= totalPages.value; i++) {
      const canvas = canvasRefs.get(i)
      if (!canvas) continue
      const pageEl = canvas.closest<HTMLElement>('[data-page]')
      if (!pageEl) continue

      const rect = pageEl.getBoundingClientRect()
      const containerRect = containerEl.getBoundingClientRect()
      const pageTop = rect.top - containerRect.top + scrollTop
      const pageBottom = pageTop + rect.height

      // 优先找占据视口最多的页
      const visibleTop = Math.max(pageTop, scrollTop)
      const visibleBottom = Math.min(pageBottom, scrollTop + containerHeight)
      const visibleHeight = Math.max(0, visibleBottom - visibleTop)

      if (visibleHeight > 0) {
        const pageCenter = pageTop + rect.height / 2
        const dist = Math.abs(viewCenter - pageCenter)
        if (dist < bestDistance) {
          bestDistance = dist
          bestPage = i
        }
      }
    }

    if (bestPage !== currentPage.value) {
      currentPage.value = bestPage
    }
  }

  /** 滚动到指定页 */
  function scrollToPage(pageNum: number, containerEl: HTMLElement): void {
    const canvas = canvasRefs.get(pageNum)
    if (!canvas || !containerEl) return
    const pageEl = canvas.closest<HTMLElement>('[data-page]')
    if (!pageEl) return

    // 计算目标页相对于容器的偏移
    const containerRect = containerEl.getBoundingClientRect()
    const pageRect = pageEl.getBoundingClientRect()
    const containerStyles = window.getComputedStyle(containerEl)
    const paddingTop = parseFloat(containerStyles.paddingTop) || 0
    const offset = pageRect.top - containerRect.top + containerEl.scrollTop - paddingTop

    containerEl.scrollTo({ top: offset, behavior: 'smooth' })
  }

  // ========== 缩放 ==========

  function zoomIn(): void {
    isFitWidth.value = false
    const newScale = Math.min(3.0, scale.value + 0.25)
    if (newScale !== scale.value) {
      scale.value = Math.round(newScale * 100) / 100
    }
  }

  function zoomOut(): void {
    isFitWidth.value = false
    const newScale = Math.max(0.25, scale.value - 0.25)
    if (newScale !== scale.value) {
      scale.value = Math.round(newScale * 100) / 100
    }
  }

  async function fitToWidth(): Promise<void> {
    if (!pdfDoc) return

    let parentWidth: number | undefined

    if (isScrollMode.value) {
      // 滚动模式下取滚动容器宽度
      const firstCanvas = canvasRefs.get(1)
      parentWidth = firstCanvas?.parentElement?.parentElement?.clientWidth
    } else {
      parentWidth = canvasRef.value?.parentElement?.clientWidth
    }

    if (!parentWidth) return

    try {
      let unscaledWidth: number
      if (firstPageUnscaledWidth !== null) {
        unscaledWidth = firstPageUnscaledWidth
      } else {
        const page = await pdfDoc.getPage(1)
        const unscaledViewport = page.getViewport({ scale: 1 })
        unscaledWidth = unscaledViewport.width
        firstPageUnscaledWidth = unscaledWidth
        page.cleanup()
      }
      const fitScale = (parentWidth - 48) / unscaledWidth
      scale.value = Math.max(0.25, Math.round(fitScale * 100) / 100)
      isFitWidth.value = true
    } catch {
      // 忽略计算错误
    }
  }

  // ========== 模式切换 ==========

  function toggleViewMode(): void {
    viewMode.value = isScrollMode.value ? 'single' : 'scroll'
    // 切换后重新渲染。两种模式均需等 DOM 更新（v-if 切换后 canvas ref 尚未挂载）
    if (isLoaded.value) {
      if (isScrollMode.value) {
        vueNextTick(() => { renderAllPages().catch(() => {}) })
      } else {
        vueNextTick(() => { renderCurrentPage() })
      }
    }
  }

  /** 注册滚动模式下的 canvas ref */
  function setCanvasRef(pageNum: number, el: Element | ComponentPublicInstance | null): void {
    if (el instanceof HTMLCanvasElement) {
      canvasRefs.set(pageNum, el)
    } else {
      canvasRefs.delete(pageNum)
    }
  }

  // ========== 监听器 ==========

  // 单页模式：页码或缩放变化时重新渲染
  watch([currentPage, scale], () => {
    if (isLoaded.value && isSingleMode.value) {
      renderCurrentPage()
    }
  })

  // 滚动模式：缩放变化时重新渲染全部页面
  watch(scale, () => {
    if (isLoaded.value && isScrollMode.value) {
      renderAllPages()
    }
  })

  // ========== 生命周期清理 ==========

  onUnmounted(() => {
    cancelRender()
    cleanupPage()
    renderedPages.clear()
    if (pdfDoc) {
      pdfDoc.destroy().catch(() => {})
      pdfDoc = null
    }
  })

  // ========== 返回 ==========

  return {
    // 状态
    canvasRef,
    canvasRefs,
    currentPage,
    totalPages,
    scale,
    isLoading,
    error,
    isLoaded,
    isFitWidth,
    fileName,
    viewMode,
    isScrollMode,
    isSingleMode,
    // 方法
    loadPdf,
    renderCurrentPage,
    renderAllPages,
    renderPageToCanvas,
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
    getPageTextContent,
  }
}
