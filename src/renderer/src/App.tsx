import { useState } from 'react'
import TitleBar from './components/TitleBar'
import BrowseView from './pages/Browse'
import HomeView from './pages/Home'
import Settings from './pages/Settings'
import Console from './pages/Console'
import AboutPage from './pages/About'
import type { AppView } from './types'

function App(): React.JSX.Element {
  const [view, setView] = useState<AppView>('home')
  /** 从首页点分类进列表页时要默认选中的一级分类 */
  const [browseCategoryId, setBrowseCategoryId] = useState<string | null>(null)

  const openBrowse = (categoryId: string): void => {
    setBrowseCategoryId(categoryId)
    setView('browse')
  }

  return (
    <div className="app-shell">
      <TitleBar view={view} onNavigate={setView} />
      <main className="app-body">
        {/* key 保证切换页面时重放一次轻微的淡入 */}
        <div className="page" key={view}>
          {view === 'home' && (
            <HomeView onOpenConsole={() => setView('console')} onOpenBrowse={openBrowse} />
          )}
          {view === 'browse' && (
            <BrowseView initialCategoryId={browseCategoryId} onBack={() => setView('home')} />
          )}
          {view === 'console' && <Console onBack={() => setView('home')} />}
          {view === 'settings' && <Settings onBack={() => setView('home')} />}
          {view === 'about' && <AboutPage onBack={() => setView('home')} />}
        </div>
      </main>
    </div>
  )
}

export default App
