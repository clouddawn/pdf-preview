/** PDF 文档视图尺寸 */
export interface PageViewport {
  width: number
  height: number
}

/** PDF 渲染器状态 */
export interface PdfRendererState {
  /** 当前页码 (1-based) */
  currentPage: number
  /** 总页数 */
  totalPages: number
  /** 缩放比例 (0.25 ~ 3.0) */
  scale: number
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
  /** 是否已加载文档 */
  isLoaded: boolean
}
