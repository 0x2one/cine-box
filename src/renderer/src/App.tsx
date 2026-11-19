import { useState } from 'react'
import TitleBar from './components/TitleBar'
import BrowseView from './pages/Browse'
import HomeView from './pages/Home'
import SearchView from './pages/Search'
import Settings from './pages/Settings'
import Console from './pages/Console'
import AboutPage from './pages/About'
import type { AppView } from './types'

function App(): React.JSX.Element {
  const [view, setView] = useState<AppView>('home')
  /** 从首页点分类进列表页时要默认选中的一级分类 */
  const [browseCategoryId, setBrowseCategoryId] = useState<string | null>(null)
  /** 每次进列表页都换一个 key：已经在列表页时再点「找片看」也回到「全部」 */
  const [browseEntry, setBrowseEntry] = useState(0)

  const openBrowse = (categoryId: string): void => {
    setBrowseCategoryId(categoryId)
    setBrowseEntry((entry) => entry + 1)
    setView('browse')
  }

  /** 标题栏导航：点「找片看」不沿用首页带过来的分类，直接落到「全部」 */
  const navigate = (next: AppView): void => {
    if (next === 'browse') {
      setBrowseCategoryId(null)
      setBrowseEntry((entry) => entry + 1)
    }
    setView(next)
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
            <BrowseView key={browseEntry} initialCategoryId={browseCategoryId} />
          )}
          {view === 'search' && <SearchView />}
          {view === 'console' && <Console onBack={() => setView('home')} />}
          {view === 'settings' && <Settings onBack={() => setView('home')} />}
          {view === 'about' && <AboutPage onBack={() => setView('home')} />}
        </div>
      </main>
    </div>
  )
}

export default App
