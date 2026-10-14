import * as React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/** 读取 <html> 上的 .dark class 得到主题（项目没有 next-themes），并用 MutationObserver 跟随切换 */
function useTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  const [theme, setTheme] = React.useState<'light' | 'dark'>(read)

  React.useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])

  return theme
}

/** 全局 toast 容器，挂在应用根部；toast 本身直接从 'sonner' 导入调用 */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="top-right"
      richColors
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
