import { useState } from 'react'
import TitleBar from './components/TitleBar'
import Settings from './pages/Settings'
import Console from './pages/Console'
import AboutPage from './pages/About'
import logoUrl from './assets/logo.svg'
import type { AppView } from './types'

function HomeView(): React.JSX.Element {
  return (
    <div className="home-empty">
      <div className="home-mark">
        <img src={logoUrl} alt="" />
      </div>
      <div className="home-title">映盒剧场</div>
      <div className="home-hint">暂无内容</div>
    </div>
  )
}

function App(): React.JSX.Element {
  const [view, setView] = useState<AppView>('home')

  return (
    <div className="app-shell">
      <TitleBar view={view} onNavigate={setView} />
      <main className="app-body">
        {/* key 保证切换页面时重放一次轻微的淡入 */}
        <div className="page" key={view}>
          {view === 'home' && <HomeView />}
          {view === 'console' && <Console onBack={() => setView('home')} />}
          {view === 'settings' && <Settings onBack={() => setView('home')} />}
          {view === 'about' && <AboutPage onBack={() => setView('home')} />}
        </div>
      </main>
    </div>
  )
}

export default App
