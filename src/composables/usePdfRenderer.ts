import { ref, watch, computed } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'

// 配置 PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

/** 查看模式 */
export type ViewMode = 'single' | 'scroll'

export function usePdfRenderer() {
  // ========== 状态 ==========
  /** 单页模式的 canvas ref */
  const canvasRef = ref<HTMLCanvasElement | null>(null)
  /** 滚动模式下各页的 canvas refs */
  const canvasRefs = ref<Map<number, HTMLCanvasElement>>(new Map())
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
  let renderTask: pdfjsLib.RenderTask | null = null
  let currentPageProxy: pdfjsLib.PDFPageProxy | null = null
  /** 已渲染过的页码（避免重复渲染） */
  const renderedPages = new Set<number>()

  // ========== 核心方法 ==========

  /** 将指定页渲染到目标 Canvas */
  async function renderPageToCanvas(
    pageNum: number,
    canvas: HTMLCanvasElement,
  ): Promise<void> {
    if (!pdfDoc) return

    // 取消旧的渲染任务
    cancelRender()

    try {
      const page = await pdfDoc.getPage(pageNum)

      // HiDPI 高清渲染
      const pixelRatio = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: scale.value * pixelRatio })

      const ctx = canvas.getContext('2d')!
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`
      canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`

      renderTask = page.render({ canvasContext: ctx, viewport })
      await renderTask.promise
      renderTask = null

      // 释放页面资源
      page.cleanup()
    } catch (e: unknown) {
      if (e instanceof Error && (e.message?.includes('cancelled') || e.name === 'RenderingCancelledException')) {
        return
      }
      throw e
    }
  }

  /** 渲染当前页到单页 Canvas（原有逻辑） */
  async function renderCurrentPage(): Promise<void> {
    const canvas = canvasRef.value
    if (!canvas || !pdfDoc) return

    // 清理旧页面资源
    cleanupPage()

    try {
      const page = await pdfDoc.getPage(currentPage.value)
      currentPageProxy = page

      const pixelRatio = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: scale.value * pixelRatio })

      const ctx = canvas.getContext('2d')!
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`
      canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`

      cancelRender()
      renderTask = page.render({ canvasContext: ctx, viewport })
      await renderTask.promise
      renderTask = null
    } catch (e: unknown) {
      if (e instanceof Error && (e.message?.includes('cancelled') || e.name === 'RenderingCancelledException')) {
        return
      }
      error.value = `渲染失败: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  /** 滚动模式：渲染全部页面 */
  async function renderAllPages(): Promise<void> {
    if (!pdfDoc) return

    cancelRender()
    cleanupPage()
    renderedPages.clear()
    const pageCount = pdfDoc.numPages

    for (let i = 1; i <= pageCount; i++) {
      const canvas = canvasRefs.value.get(i)
      if (!canvas) {
        // canvas 还没挂载，等下一帧
        await nextTick()
        const retryCanvas = canvasRefs.value.get(i)
        if (!retryCanvas) continue
        if (renderedPages.has(i)) continue
        renderedPages.add(i)
        await renderPageToCanvas(i, retryCanvas).catch(() => {})
      } else {
        if (renderedPages.has(i)) continue
        renderedPages.add(i)
        await renderPageToCanvas(i, canvas).catch(() => {})
      }
    }
  }

  function nextTick(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  /** 从 ArrayBuffer 加载 PDF */
  async function loadPdf(data: ArrayBuffer, name = ''): Promise<void> {
    cancelRender()
    cleanupPage()
    renderedPages.clear()
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

  /** 取消正在进行的渲染任务 */
  function cancelRender(): void {
    if (renderTask) {
      renderTask.cancel()
      renderTask = null
    }
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
      const canvas = canvasRefs.value.get(i)
      if (!canvas) continue
      const pageEl = canvas.parentElement
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
    const canvas = canvasRefs.value.get(pageNum)
    if (!canvas || !containerEl) return
    const pageEl = canvas.parentElement
    if (!pageEl) return

    // 计算目标页相对于容器的偏移
    const containerRect = containerEl.getBoundingClientRect()
    const pageRect = pageEl.getBoundingClientRect()
    const offset = pageRect.top - containerRect.top + containerEl.scrollTop - 16 // 16px padding

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
      const firstCanvas = canvasRefs.value.get(1)
      parentWidth = firstCanvas?.parentElement?.parentElement?.clientWidth
    } else {
      parentWidth = canvasRef.value?.parentElement?.clientWidth
    }

    if (!parentWidth) return

    try {
      const page = await pdfDoc.getPage(1)
      const unscaledViewport = page.getViewport({ scale: 1 })
      const fitScale = (parentWidth - 48) / unscaledViewport.width
      scale.value = Math.round(fitScale * 100) / 100
      isFitWidth.value = true
    } catch {
      // 忽略计算错误
    }
  }

  // ========== 模式切换 ==========

  function toggleViewMode(): void {
    viewMode.value = isScrollMode.value ? 'single' : 'scroll'
    // 切换后重新渲染
    renderedPages.clear()
    if (isLoaded.value) {
      if (isScrollMode.value) {
        // 等 DOM 更新后再渲染
        setTimeout(() => renderAllPages(), 50)
      } else {
        renderCurrentPage()
      }
    }
  }

  /** 注册滚动模式下的 canvas ref */
  function setCanvasRef(pageNum: number, el: Element | ComponentPublicInstance | null): void {
    if (el instanceof HTMLCanvasElement) {
      canvasRefs.value.set(pageNum, el)
    } else {
      canvasRefs.value.delete(pageNum)
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
      renderedPages.clear()
      renderAllPages()
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
  }
}

