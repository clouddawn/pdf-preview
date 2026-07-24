import { ref, type Ref } from 'vue'
import type { PageTextResult, PdfTextItem } from './usePdfRenderer'

// ========== 类型定义 ==========

/** 单个高亮矩形（CSS 像素坐标，相对于所在页面 canvas 的左上角） */
export interface HighlightRect {
  left: number
  top: number
  width: number
  height: number
}

/** 单条匹配结果 */
export interface SearchMatch {
  pageNum: number
  /** 该匹配项在所在页中的高亮包围盒（合并所有涉及的 TextItem） */
  rects: HighlightRect[]
}

/** 缓存的页面数据 */
interface PageCache {
  /** 拼接后的页面文本（小写），用于子串搜索 */
  flatText: string
  /** flatText 中每个字符对应的 TextItem（用于将匹配位置映射回 TextItem） */
  charToItem: PdfTextItem[]
  /** 未缩放的页面尺寸 */
  pageWidth: number
  pageHeight: number
}

// ========== 工具函数 ==========

/** 将 PDF 坐标转换为 CSS 像素坐标 */
function pdfToCssRect(
  item: PdfTextItem,
  pageHeight: number,
  scale: number,
): HighlightRect {
  const tx = item.transform
  const x = tx[4] * scale
  // PDF y 轴原点在底部，CSS y 轴原点在顶部 → 翻转
  const y = (pageHeight - tx[5]) * scale
  const w = item.width * scale
  const h = item.height * scale

  return { left: x, top: y, width: w, height: h }
}

/** 合并多个矩形为一个最小包围盒 */
function unionRects(rects: HighlightRect[]): HighlightRect {
  if (rects.length === 0) return { left: 0, top: 0, width: 0, height: 0 }
  const left = Math.min(...rects.map(r => r.left))
  const top = Math.min(...rects.map(r => r.top))
  const right = Math.max(...rects.map(r => r.left + r.width))
  const bottom = Math.max(...rects.map(r => r.top + r.height))
  return { left, top, width: right - left, height: bottom - top }
}

// ========== Composable ==========

export function usePdfSearch(
  getPageTextContent: (pageNum: number) => Promise<PageTextResult | null>,
  totalPages: Ref<number>,
  scale: Ref<number>,
  isLoaded: Ref<boolean>,
) {
  // ========== 状态 ==========

  const query = ref('')
  const matches = ref<SearchMatch[]>([])
  const currentMatchIndex = ref(-1)
  const isSearching = ref(false)

  // ========== 内部变量 ==========

  /** 页面文本缓存（key 为页码） */
  const pageCache = new Map<number, PageCache>()
  /** 搜索取消令牌 */
  let abortController: AbortController | null = null
  /** 防抖定时器 */
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  // ========== 核心方法 ==========

  /** 确保指定页已缓存（如未缓存则从 PDF 获取文本） */
  async function ensurePageCached(pageNum: number): Promise<PageCache | null> {
    const cached = pageCache.get(pageNum)
    if (cached) return cached

    const result = await getPageTextContent(pageNum)
    if (!result) return null

    const { items, pageWidth, pageHeight } = result

    // 拼接文本并建立字符 → TextItem 映射
    const parts: string[] = []
    const charToItem: PdfTextItem[] = []

    for (const item of items) {
      parts.push(item.str)
      for (let i = 0; i < item.str.length; i++) {
        charToItem.push(item)
      }
    }

    const cache: PageCache = {
      flatText: parts.join('').toLowerCase(),
      charToItem,
      pageWidth,
      pageHeight,
    }

    pageCache.set(pageNum, cache)
    return cache
  }

  /** 执行全文搜索 */
  async function doSearch(q: string): Promise<void> {
    // 取消防抖
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }

    // 取消上一次搜索
    if (abortController) { abortController.abort(); abortController = null }

    // 空查询 → 清除结果
    if (!q.trim()) { clearSearch(); return }

    const keyword = q.trim().toLowerCase()
    isSearching.value = true
    abortController = new AbortController()
    const signal = abortController.signal
    const allMatches: SearchMatch[] = []

    try {
      for (let pageNum = 1; pageNum <= totalPages.value; pageNum++) {
        if (signal.aborted) return
        const cache = await ensurePageCached(pageNum)
        if (!cache || signal.aborted) return
        allMatches.push(...findMatchesInPage(cache, keyword, pageNum))
      }
      if (signal.aborted) return
      matches.value = allMatches
      currentMatchIndex.value = allMatches.length > 0 ? 0 : -1
    } catch {
      if (!signal.aborted) {
        matches.value = allMatches
        currentMatchIndex.value = allMatches.length > 0 ? 0 : -1
      }
    } finally {
      isSearching.value = false
      abortController = null
    }
  }

  /** 在单页文本中查找所有匹配 */
  function findMatchesInPage(
    cache: PageCache,
    keyword: string,
    pageNum: number,
  ): SearchMatch[] {
    const { flatText, charToItem, pageHeight } = cache
    const s = scale.value
    const results: SearchMatch[] = []

    let from = 0
    while (from < flatText.length) {
      const idx = flatText.indexOf(keyword, from)
      if (idx === -1) break

      // 收集匹配关键词所涉及的所有 TextItem
      const involvedItems = new Set<PdfTextItem>()
      for (let i = idx; i < idx + keyword.length; i++) {
        involvedItems.add(charToItem[i])
      }

      // 为每个涉及的 TextItem 计算 CSS 像素矩形
      const itemRects = Array.from(involvedItems, item =>
        pdfToCssRect(item, pageHeight, s),
      )

      results.push({ pageNum, rects: [unionRects(itemRects)] })
      from = idx + keyword.length
    }

    return results
  }

  /** 带防抖的搜索入口 */
  function searchDebounced(q: string, delay = 300): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => doSearch(q), delay)
  }

  /** 下一个匹配（循环） */
  function nextMatch(): void {
    if (matches.value.length === 0) return
    currentMatchIndex.value = (currentMatchIndex.value + 1) % matches.value.length
  }

  /** 上一个匹配（循环） */
  function prevMatch(): void {
    if (matches.value.length === 0) return
    const len = matches.value.length
    currentMatchIndex.value = (currentMatchIndex.value - 1 + len) % len
  }

  /** 清除搜索 */
  function clearSearch(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    if (abortController) { abortController.abort(); abortController = null }
    query.value = ''
    matches.value = []
    currentMatchIndex.value = -1
    isSearching.value = false
  }

  /** 清除文本缓存（PDF 切换或 scale 变化时调用） */
  function invalidateCache(): void {
    pageCache.clear()
  }

  /** 清除缓存并重新搜索 */
  function refreshSearch(): void {
    invalidateCache()
    if (query.value.trim()) {
      searchDebounced(query.value, 150)
    }
  }

  // ========== 模板辅助方法 ==========

  /** 检查指定页是否有匹配 */
  function hasPageMatches(pageNum: number): boolean {
    return matches.value.some(m => m.pageNum === pageNum)
  }

  /** 获取指定页的高亮数据（含 rects 和当前激活标记） */
  function getPageHighlightData(pageNum: number): { rects: HighlightRect[]; activeIndex: number | null } {
    const pageMatches: SearchMatch[] = []
    let firstGlobalIdx = -1

    for (let i = 0; i < matches.value.length; i++) {
      if (matches.value[i].pageNum === pageNum) {
        if (firstGlobalIdx === -1) firstGlobalIdx = i
        pageMatches.push(matches.value[i])
      }
    }

    const rects = pageMatches.flatMap(m => m.rects)
    const activeIdx = currentMatchIndex.value

    let activeLocalIdx: number | null = null
    if (activeIdx >= firstGlobalIdx && activeIdx < firstGlobalIdx + pageMatches.length) {
      // 每个 match 的 rects 数量可能不同，计算当前 match 在该页 rects 中的起始偏移
      let rectOffset = 0
      for (let i = firstGlobalIdx; i < activeIdx; i++) {
        rectOffset += matches.value[i].rects.length
      }
      activeLocalIdx = rectOffset
    }

    return { rects, activeIndex: activeLocalIdx }
  }

  // ========== 返回 ==========

  return {
    query,
    matches,
    currentMatchIndex,
    isSearching,
    doSearch,
    searchDebounced,
    nextMatch,
    prevMatch,
    clearSearch,
    invalidateCache,
    refreshSearch,
    hasPageMatches,
    getPageHighlightData,
  }
}
