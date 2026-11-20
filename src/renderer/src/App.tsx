import { useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import BrowseView from './pages/Browse'
import HomeView from './pages/Home'
import SearchView from './pages/Search'
import Settings from './pages/Settings'
import Console from './pages/Console'
import AboutPage from './pages/About'
import type { AppView } from './types'

/** 展示端页面：控制台 / 设置的返回回到最近停留的这一个 */
function isDisplayView(view: AppView): view is 'home' | 'browse' | 'search' {
  return view === 'home' || view === 'browse' || view === 'search'
}

function App({ startView = 'home' }: { startView?: AppStartView }): React.JSX.Element {
  const [view, setView] = useState<AppView>(startView)
  /** 从首页点分类进列表页时要默认选中的一级分类 */
  const [browseCategoryId, setBrowseCategoryId] = useState<string | null>(null)
  /** 每次进列表页都换一个 key：已经在列表页时再点「找片看」也回到「全部」 */
  const [browseEntry, setBrowseEntry] = useState(0)
  /** 搜索页当前提交的关键词：离开再回来时用它恢复搜索结果 */
  const [searchKeyword, setSearchKeyword] = useState('')
  /** 去控制台 / 设置之前停留在哪个展示端页面，返回时用它（而不是固定回推荐页） */
  const lastDisplayRef = useRef<AppView>(startView)
  /**
   * 找片看当前选中的分类。放在 ref 里而不是 state：用户在列表页切分类时
   * 不需要重新挂载整页，只有离开之后再回来（返回时）才把值读回来当初始值。
   */
  const browsePickRef = useRef<string | null>(null)

  const openBrowse = (categoryId: string | null): void => {
    lastDisplayRef.current = 'browse'
    browsePickRef.current = categoryId
    setBrowseCategoryId(categoryId)
    setBrowseEntry((entry) => entry + 1)
    setView('browse')
  }

  /** 标题栏导航：点「找片看」不沿用首页带过来的分类，直接落到「全部」 */
  const navigate = (next: AppView): void => {
    if (isDisplayView(next)) lastDisplayRef.current = next
    if (next === 'browse') {
      browsePickRef.current = null
      setBrowseCategoryId(null)
      setBrowseEntry((entry) => entry + 1)
    }
    // 点标题栏的搜索总是从搜索落地页开始；从控制台 / 设置返回走 backToDisplay，不受影响
    if (next === 'search' && view !== 'search') setSearchKeyword('')
    setView(next)
  }

  /** 控制台 / 设置的返回：回到进来之前的展示端页面，并恢复列表页的分类与搜索词 */
  const backToDisplay = (): void => {
    const target = lastDisplayRef.current
    if (target === 'browse') setBrowseCategoryId(browsePickRef.current)
    setView(target)
  }

  return (
    <div className="app-shell">
      <TitleBar view={view} onNavigate={navigate} />
      <main className="app-body">
        {/* key 保证切换页面时重放一次轻微的淡入 */}
        <div className="page" key={view}>
          {view === 'home' && (
            <HomeView onOpenConsole={() => setView('console')} onOpenBrowse={openBrowse} />
          )}
          {view === 'browse' && (
            <BrowseView
              key={browseEntry}
              initialCategoryId={browseCategoryId}
              onCategoryChange={(categoryId) => {
                browsePickRef.current = categoryId
              }}
            />
          )}
          {view === 'search' && (
            <SearchView
              initialKeyword={searchKeyword}
              onKeywordChange={setSearchKeyword}
              onOpenBrowse={openBrowse}
            />
          )}
          {view === 'console' && <Console onBack={backToDisplay} />}
          {view === 'settings' && <Settings onBack={backToDisplay} />}
          {view === 'about' && <AboutPage onBack={backToDisplay} />}
        </div>
      </main>
    </div>
  )
}

export default App
