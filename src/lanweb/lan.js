;(function () {
  'use strict'

  var app = document.getElementById('app')
  var HISTORY_KEY = 'cinebox-lan-search-history'
  var MODE_KEY = 'cinebox-lan-search-mode'
  var AUTO_NEXT_KEY = 'cinebox-lan-auto-next'
  var PAGE_SIZE = 20
  var HOME_SIZE = 12
  /** 找片看每页 30 条：和展示端列表页一致，缓存库单页上限 100 */
  var BROWSE_SIZE = 30
  /** 距底部这么多像素就预取下一页 */
  var BROWSE_LOAD_AHEAD = 600
  /** 滚过这么多像素浮出「回到顶部」 */
  var BACK_TOP_AT = 600
  var APP_TITLE = '映盒剧场'
  var HLS_SCRIPT = '/assets/hls.min.js'

  var MODE_HINTS = {
    local: '在已收录的片库里检索，秒出结果',
    online: '实时向支持检索的采集站点发起请求，可能需要几秒'
  }

  var ICONS = {
    search:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.3-3.3"></path></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"></path></svg>',
    chevron:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"></path></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></svg>',
    wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14 0"></path><path d="M8.5 16.1a6 6 0 0 1 7 0"></path><path d="M12 20h.01"></path></svg>'
  }

  var ERROR_TEXT = {
    CACHE_UNAVAILABLE: '片库缓存还没准备好，请稍后再试',
    SEARCH_FAILED: '检索失败，请稍后重试',
    LATEST_FAILED: '读取最新收录失败',
    CATEGORIES_FAILED: '读取分类失败，请稍后重试',
    BROWSE_FAILED: '读取视频列表失败，请稍后重试',
    DETAIL_FAILED: '读取播放信息失败',
    NOT_FOUND: '这个视频不在片库里',
    INVALID_INPUT: '请输入关键词',
    FORBIDDEN: '播放地址没有被授权，请重新打开播放页',
    UPSTREAM_FAILED: '播放源暂时连不上，换一条线路试试',
    TIMEOUT: '请求超时，请重试'
  }

  var renderSeq = 0
  var cleanup = null
  var toastTimer = 0
  var hlsPromise = null
  var modeValue = readStoredMode()

  /* ── 基础工具 ── */

  function icon(name) {
    return ICONS[name] || ''
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(
      /[&<>"']/g,
      function (character) {
        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        }[character]
      }
    )
  }

  function safeUrl(value) {
    var text = String(value === null || value === undefined ? '' : value).trim()
    if (!text) return ''
    try {
      var url = new URL(text)
      return url.protocol === 'http:' || url.protocol === 'https:' ? text : ''
    } catch (error) {
      return ''
    }
  }

  function isHls(value) {
    var text = String(value || '').trim()
    if (!text) return false
    try {
      var url = new URL(text)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      if (url.pathname.toLowerCase().endsWith('.m3u8')) return true
    } catch (error) {
      // 退回正则
    }
    return /\.m3u8(?:[?#]|$)/i.test(text)
  }

  function formatCount(value) {
    var number = Number(value)
    if (!Number.isFinite(number)) return '0'
    try {
      return new Intl.NumberFormat('zh-CN').format(number)
    } catch (error) {
      return String(number)
    }
  }

  function formatDate(value) {
    var text = String(value || '').trim()
    if (!text) return ''
    var date = new Date(text.indexOf(' ') > 0 ? text.replace(' ', 'T') : text)
    if (Number.isNaN(date.getTime())) return text
    return (
      date.getFullYear() +
      '.' +
      String(date.getMonth() + 1).padStart(2, '0') +
      '.' +
      String(date.getDate()).padStart(2, '0')
    )
  }

  function metaLine(item) {
    var parts = [
      item.note,
      item.vodClass,
      item.sourceCount > 1 ? item.sourceCount + ' 个来源' : '',
      formatDate(item.latestTime)
    ]
    return unique(parts).join(' · ')
  }

  function metaShort(item) {
    return item.note || item.vodClass || (item.sourceCount > 1 ? item.sourceCount + ' 个来源' : '')
  }

  function unique(values) {
    var seen = Object.create(null)
    return values.filter(function (value) {
      var text = String(value === null || value === undefined ? '' : value).trim()
      if (!text || seen[text]) return false
      seen[text] = true
      return true
    })
  }

  function picOf(item) {
    var candidates = []
    if (item) {
      candidates.push(item.pic)
      if (Array.isArray(item.picCandidates)) candidates = candidates.concat(item.picCandidates)
    }
    for (var index = 0; index < candidates.length; index += 1) {
      var url = safeUrl(candidates[index])
      if (url) return url
    }
    return ''
  }

  function initialOf(item) {
    var name = String((item && item.name) || '?').trim()
    return esc(name.slice(0, 1) || '?')
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function highlight(text, keyword) {
    var raw = String(text === null || text === undefined ? '' : text)
    var words = String(keyword || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
    if (words.length === 0) return esc(raw)
    var expression = new RegExp('(' + words.map(escapeRegExp).join('|') + ')', 'gi')
    return raw
      .split(expression)
      .map(function (part, index) {
        return index % 2 === 1 ? '<mark>' + esc(part) + '</mark>' : esc(part)
      })
      .join('')
  }

  function closestFrom(event, selector) {
    var target = event.target
    return target && target.closest ? target.closest(selector) : null
  }

  function errorText(error, fallback) {
    var code = (error && error.payload && error.payload.error) || (error && error.message) || ''
    return ERROR_TEXT[code] || fallback || '出了点问题，请稍后重试'
  }

  function readStoredMode() {
    try {
      return localStorage.getItem(MODE_KEY) === 'online' ? 'online' : 'local'
    } catch (error) {
      return 'local'
    }
  }

  function storeMode(mode) {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch (error) {
      // 隐私模式下忽略
    }
  }

  function readHistory() {
    try {
      var raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
      if (!Array.isArray(raw)) return []
      return raw
        .filter(function (item) {
          return typeof item === 'string' && item.trim()
        })
        .slice(0, 10)
    } catch (error) {
      return []
    }
  }

  function writeHistory(items) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 10)))
    } catch (error) {
      // 忽略
    }
  }

  function pushHistory(keyword) {
    var key = keyword.toLowerCase()
    var items = readHistory().filter(function (item) {
      return item.toLowerCase() !== key
    })
    items.unshift(keyword)
    writeHistory(items)
  }

  function readAutoNext() {
    try {
      return localStorage.getItem(AUTO_NEXT_KEY) !== '0'
    } catch (error) {
      return true
    }
  }

  function storeAutoNext(value) {
    try {
      localStorage.setItem(AUTO_NEXT_KEY, value ? '1' : '0')
    } catch (error) {
      // 忽略
    }
  }

  function showToast(text) {
    var element = document.querySelector('.toast')
    if (!element) {
      element = document.createElement('div')
      element.className = 'toast'
      document.body.appendChild(element)
    }
    element.textContent = text
    element.classList.add('is-show')
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(function () {
      element.classList.remove('is-show')
    }, 2200)
  }

  /* ── 路由 ── */

  function parseRoute() {
    var raw = window.location.hash.replace(/^#/, '') || '/'
    var queryIndex = raw.indexOf('?')
    var path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw
    var params = new URLSearchParams(queryIndex >= 0 ? raw.slice(queryIndex + 1) : '')
    if (path === '/' || path === '') return { name: 'home', params: params }
    if (path === '/search') return { name: 'search', params: params }
    if (path === '/browse') return { name: 'browse', params: params }
    var match = /^\/play\/(\d+)$/.exec(path)
    if (match) return { name: 'play', id: Number(match[1]), params: params }
    return { name: 'notfound', params: params }
  }

  function navigate(path) {
    var target = path.charAt(0) === '#' ? path : '#' + path
    if (window.location.hash === target) {
      renderRoute()
      return
    }
    window.location.hash = target
  }

  function renderRoute() {
    if (cleanup) {
      try {
        cleanup()
      } catch (error) {
        // 清理失败不影响下一页
      }
      cleanup = null
    }
    var token = ++renderSeq
    var route = parseRoute()
    window.scrollTo(0, 0)
    if (route.name === 'home') renderHome(token)
    else if (route.name === 'search') renderSearch(route, token)
    else if (route.name === 'browse') renderBrowse(route, token)
    else if (route.name === 'play') renderPlay(route, token)
    else renderNotFound()
  }

  function setCleanup(fn) {
    cleanup = fn
  }

  function bindBack() {
    var button = document.getElementById('back-btn')
    if (!button) return
    button.addEventListener('click', function () {
      if (window.history.length > 1) window.history.back()
      else navigate('/')
    })
  }

  /* ── 数据请求 ── */

  function getJson(path, params) {
    var search = new URLSearchParams()
    if (params) {
      Object.keys(params).forEach(function (key) {
        var value = params[key]
        if (value !== undefined && value !== null) search.set(key, String(value))
      })
    }
    var query = search.toString()
    var url = query ? path + '?' + query : path
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null
        })
        .then(function (data) {
          if (!response.ok || !data) {
            var error = new Error((data && data.error) || 'HTTP_' + response.status)
            error.status = response.status
            error.payload = data
            throw error
          }
          if (data.ok === false) {
            var failed = new Error(data.error || 'REQUEST_FAILED')
            failed.payload = data
            throw failed
          }
          return data
        })
    })
  }

  /* ── 通用片段 ── */

  function topbarHtml(options) {
    var back =
      options && options.back
        ? '<button type="button" class="icon-btn" id="back-btn" aria-label="返回">' +
          icon('back') +
          '</button>'
        : ''
    // 导航只在推荐 / 找片看两个展示页出现：搜索 / 播放页左边已经有「返回」，
    // 手机上再塞两个入口会把标题栏挤爆。
    var nav =
      options && options.nav
        ? '<nav class="topbar-nav" aria-label="浏览">' +
          '<a class="topbar-nav-link' +
          (options.nav === 'home' ? ' is-active' : '') +
          '" href="#/"' +
          (options.nav === 'home' ? ' aria-current="page"' : '') +
          '>推荐</a>' +
          '<a class="topbar-nav-link' +
          (options.nav === 'browse' ? ' is-active' : '') +
          '" href="#/browse"' +
          (options.nav === 'browse' ? ' aria-current="page"' : '') +
          '>找片看</a>' +
          '</nav>'
        : ''
    return (
      '<header class="topbar"><div class="topbar-left">' +
      back +
      '<a class="brand" href="#/" aria-label="映盒剧场首页"><span class="brand-mark" aria-hidden="true">映</span><span class="brand-text"><strong>映盒剧场</strong><span class="brand-sub">局域网影院</span></span></a>' +
      '</div>' +
      nav +
      '<span class="lan-pill"><i aria-hidden="true"></i>LAN</span></header>'
    )
  }

  function searchPanelHtml(value, mode) {
    return (
      '<div class="search-panel"><form class="search-form" id="search-form" role="search" novalidate>' +
      '<span class="search-form-icon" aria-hidden="true">' +
      icon('search') +
      '</span>' +
      '<input id="search-input" type="search" name="q" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="60" placeholder="搜索片名…" aria-label="搜索关键词" value="' +
      esc(value) +
      '" />' +
      '<button class="search-submit" type="submit">搜索</button>' +
      '</form>' +
      '<div class="mode-row"><div class="mode-switch" role="group" aria-label="检索范围">' +
      '<button type="button" class="mode-btn' +
      (mode === 'local' ? ' is-active' : '') +
      '" data-mode="local" aria-pressed="' +
      (mode === 'local') +
      '">本地片库</button>' +
      '<button type="button" class="mode-btn' +
      (mode === 'online' ? ' is-active' : '') +
      '" data-mode="online" aria-pressed="' +
      (mode === 'online') +
      '">在线检索</button>' +
      '</div><p class="mode-hint">' +
      MODE_HINTS[mode] +
      '</p></div></div>'
    )
  }

  function bindSearch(options) {
    var form = document.getElementById('search-form')
    var input = document.getElementById('search-input')
    if (!form || !input) return
    var hint = form.parentElement.querySelector('.mode-hint')
    var mode = options.mode

    var setMode = function (next) {
      mode = next
      modeValue = next
      storeMode(next)
      form.parentElement.querySelectorAll('.mode-btn').forEach(function (button) {
        var active = button.dataset.mode === next
        button.classList.toggle('is-active', active)
        button.setAttribute('aria-pressed', String(active))
      })
      if (hint) hint.textContent = MODE_HINTS[next]
    }

    form.parentElement.querySelectorAll('.mode-btn').forEach(function (button) {
      button.addEventListener('click', function () {
        var next = button.dataset.mode === 'online' ? 'online' : 'local'
        if (next === mode) return
        setMode(next)
        if (options.onModeChange) options.onModeChange(next, input.value.trim())
      })
    })

    form.addEventListener('submit', function (event) {
      event.preventDefault()
      var keyword = input.value.trim().replace(/\s+/g, ' ').slice(0, 60)
      if (!keyword) {
        form.classList.add('is-empty')
        window.setTimeout(function () {
          form.classList.remove('is-empty')
        }, 600)
        input.focus()
        return
      }
      pushHistory(keyword)
      if (options.onSubmit) options.onSubmit(keyword, mode)
      else navigate('/search?q=' + encodeURIComponent(keyword) + '&mode=' + mode)
    })
  }

  function historyHtml() {
    var items = readHistory()
    if (items.length === 0) return ''
    return (
      '<div class="history" id="history"><span class="history-label">最近搜索</span>' +
      items
        .map(function (word) {
          return (
            '<button type="button" class="history-chip" data-word="' +
            esc(word) +
            '">' +
            esc(word) +
            '</button>'
          )
        })
        .join('') +
      '<button type="button" class="history-clear" id="history-clear">清空</button></div>'
    )
  }

  function bindHistory() {
    var box = document.getElementById('history')
    if (!box) return
    box.addEventListener('click', function (event) {
      var target = closestFrom(event, 'button')
      if (!target) return
      if (target.id === 'history-clear') {
        writeHistory([])
        box.remove()
        return
      }
      var word = target.dataset.word
      if (!word) return
      var input = document.getElementById('search-input')
      if (input) {
        input.value = word
        input.focus()
      }
      var form = document.getElementById('search-form')
      if (!form) return
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.dispatchEvent(new Event('submit', { cancelable: true }))
    })
  }

  function stateBoxHtml(options) {
    var action = options.action
      ? '<button type="button" class="ghost-btn" id="' +
        esc(options.action.id) +
        '">' +
        esc(options.action.label) +
        '</button>'
      : ''
    return (
      '<div class="state-box"><span class="state-icon" aria-hidden="true">' +
      icon(options.icon || 'film') +
      '</span><h3>' +
      esc(options.title) +
      '</h3><p>' +
      esc(options.desc || '') +
      '</p>' +
      action +
      '</div>'
    )
  }

  function posterSkeletons(count) {
    var html = ''
    for (var index = 0; index < count; index += 1) {
      html +=
        '<div class="poster-card is-skeleton" aria-hidden="true"><span class="poster-frame sk"></span><span class="sk-line sk"></span><span class="sk-line short sk"></span></div>'
    }
    return html
  }

  function rowSkeletons(count) {
    var html = ''
    for (var index = 0; index < count; index += 1) {
      html +=
        '<div class="result-row is-skeleton" aria-hidden="true"><span class="result-cover sk"></span><span class="result-body"><span class="sk-line sk"></span><span class="sk-line short sk"></span><span class="sk-line sk"></span></span></div>'
    }
    return html
  }

  function coverHtml(item, variant) {
    var pic = picOf(item)
    var image = pic
      ? '<img src="' +
        esc(pic) +
        '" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover-id="' +
        item.id +
        '" />'
      : ''
    if (variant === 'row') {
      return (
        '<span class="result-cover"><span class="poster-fallback" aria-hidden="true">' +
        initialOf(item) +
        '</span>' +
        image +
        '</span>'
      )
    }
    return (
      '<span class="poster-frame"><span class="poster-fallback" aria-hidden="true">' +
      initialOf(item) +
      '</span>' +
      image +
      '<span class="poster-play" aria-hidden="true">' +
      icon('play') +
      '</span></span>'
    )
  }

  function bindCoverImages(root, items) {
    var byId = {}
    items.forEach(function (item) {
      byId[item.id] = item
    })
    root.querySelectorAll('img[data-cover-id]').forEach(function (img) {
      var item = byId[img.dataset.coverId]
      if (!item) return
      var candidates = []
      var raw = [item.pic].concat(Array.isArray(item.picCandidates) ? item.picCandidates : [])
      raw.forEach(function (value) {
        var url = safeUrl(value)
        if (url && candidates.indexOf(url) < 0) candidates.push(url)
      })
      var index = Math.max(0, candidates.indexOf(img.getAttribute('src') || ''))
      img.addEventListener('load', function () {
        img.classList.add('is-loaded')
      })
      img.addEventListener('error', function () {
        index += 1
        if (index < candidates.length) {
          img.src = candidates[index]
          return
        }
        img.remove()
      })
      if (img.complete && img.naturalWidth > 0) img.classList.add('is-loaded')
    })
  }

  function appendHtml(container, html, items) {
    var holder = document.createElement('div')
    holder.innerHTML = html
    bindCoverImages(holder, items)
    while (holder.firstChild) container.appendChild(holder.firstChild)
  }

  /** 首页「最近收录」和找片看共用同一张海报卡 */
  function posterCardHtml(item) {
    return (
      '<a class="poster-card" href="#/play/' +
      item.id +
      '" aria-label="' +
      esc(item.name) +
      '">' +
      coverHtml(item) +
      '<span class="poster-name">' +
      esc(item.name) +
      '</span><span class="poster-meta">' +
      esc(metaShort(item)) +
      '</span></a>'
    )
  }

  /* ── 首页 ── */

  function renderHome(token) {
    document.title = APP_TITLE + ' · 局域网影院'
    var mode = modeValue
    app.innerHTML =
      topbarHtml({ nav: 'home' }) +
      '<main class="page home">' +
      '<section class="home-hero">' +
      '<p class="eyebrow">同一局域网 · 扫码即看</p>' +
      '<h1>今晚，看点什么？</h1>' +
      '<p class="hero-desc">搜索映盒剧场里的片库，或者直接向采集站点发起在线检索。选中的视频会直接在浏览器里播放。</p>' +
      searchPanelHtml('', mode) +
      historyHtml() +
      '</section>' +
      '<section class="browse-entry" id="browse-entry" hidden>' +
      '<div class="section-head"><h2>找片看</h2><a class="section-link" href="#/browse">全部视频 <span aria-hidden="true">›</span></a></div>' +
      '<div class="type-chips" id="home-types"></div>' +
      '</section>' +
      '<section class="latest-section" aria-labelledby="latest-title">' +
      '<div class="section-head"><h2 id="latest-title">最近收录</h2><span class="section-meta" id="latest-meta">正在读取片库…</span></div>' +
      '<div class="card-grid" id="latest-grid">' +
      posterSkeletons(6) +
      '</div>' +
      '</section>' +
      '<footer class="page-foot"><span><strong>映盒剧场</strong> · 局域网影院</span><span>内容来自本片库 · 请在同一局域网内使用</span></footer>' +
      '</main>'
    bindSearch({ mode: mode })
    bindHistory()
    loadHomeTypes(token)

    var grid = document.getElementById('latest-grid')
    var meta = document.getElementById('latest-meta')
    if (!grid) return
    getJson('/api/latest', { page: 1, pageSize: HOME_SIZE })
      .then(function (data) {
        if (token !== renderSeq) return
        var items = Array.isArray(data.items) ? data.items : []
        if (items.length === 0) {
          grid.innerHTML = ''
          grid.insertAdjacentHTML(
            'afterend',
            stateBoxHtml({
              icon: 'film',
              title: '片库还是空的',
              desc: '先在映盒剧场控制台采集一些视频，再回到这里刷新。',
              action: { id: 'reload-home', label: '重新加载' }
            })
          )
          var button = document.getElementById('reload-home')
          if (button) button.addEventListener('click', renderRoute)
          if (meta) meta.textContent = ''
          return
        }
        grid.innerHTML = items.map(posterCardHtml).join('')
        bindCoverImages(grid, items)
        if (meta) meta.textContent = '最新 ' + formatCount(items.length) + ' 部'
      })
      .catch(function (error) {
        if (token !== renderSeq) return
        grid.innerHTML = ''
        grid.insertAdjacentHTML(
          'afterend',
          stateBoxHtml({
            icon: 'film',
            title: '读取片库失败',
            desc: errorText(error, '请稍后重试'),
            action: { id: 'reload-home', label: '重新加载' }
          })
        )
        var button = document.getElementById('reload-home')
        if (button) button.addEventListener('click', renderRoute)
        if (meta) meta.textContent = ''
      })
  }

  /** 首页的「找片看」快捷入口：分类读取失败就整块不出现，不影响其它内容 */
  function loadHomeTypes(token) {
    getJson('/api/categories')
      .then(function (data) {
        if (token !== renderSeq) return
        var categories = Array.isArray(data.categories) ? data.categories : []
        var tops = categories.filter(function (row) {
          return row.parentId === null
        })
        var box = document.getElementById('browse-entry')
        var chips = document.getElementById('home-types')
        if (!box || !chips || tops.length === 0) return
        chips.innerHTML =
          '<a class="type-chip" href="#/browse">全部</a>' +
          tops
            .map(function (top) {
              return (
                '<a class="type-chip" href="#/browse?cat=' +
                encodeURIComponent(top.id) +
                '">' +
                esc(top.name) +
                '</a>'
              )
            })
            .join('')
        box.hidden = false
      })
      .catch(function () {
        // 分类接口不可用时首页照常显示，只是没有这个入口
      })
  }

  /* ── 找片看（分类 + 视频列表） ── */

  function sortCategories(rows) {
    return rows.slice().sort(function (left, right) {
      return (Number(left.sortOrder) || 0) - (Number(right.sortOrder) || 0)
    })
  }

  /**
   * 初始选中：链接里的分类优先，只认两级（一级分类或它的直接子分类）。
   * 分类被删 / 隐藏 / 层级更深时退回「全部」，和展示端列表页同一套口径。
   */
  function resolveBrowseSelection(categories, initialCat) {
    var byId = Object.create(null)
    categories.forEach(function (row) {
      byId[row.id] = row
    })
    var initial = initialCat ? byId[initialCat] : null
    if (!initial) return { topId: null, subId: null }
    if (initial.parentId === null) return { topId: initial.id, subId: null }
    var parent = byId[initial.parentId]
    if (!parent || parent.parentId !== null) return { topId: null, subId: null }
    return { topId: parent.id, subId: initial.id }
  }

  function renderBrowse(route, token) {
    var initialCat = String(route.params.get('cat') || '').trim()
    document.title = '找片看 · ' + APP_TITLE
    app.innerHTML =
      topbarHtml({ nav: 'browse' }) +
      '<main class="page page-browse">' +
      '<header class="browse-head" id="browse-head"><div class="browse-head-inner">' +
      '<div class="browse-head-top"><p class="browse-eyebrow">找片看</p>' +
      '<h1 class="browse-title" id="browse-title">全部视频</h1>' +
      '<span class="browse-meta">按更新时间排序</span></div>' +
      '<nav class="browse-types" id="browse-types" aria-label="视频类型" hidden></nav>' +
      '<nav class="browse-subs" id="browse-subs" aria-label="视频子类型" hidden></nav>' +
      '</div></header>' +
      '<div id="browse-state" hidden></div>' +
      '<div class="browse-grid card-grid" id="browse-grid">' +
      posterSkeletons(9) +
      '</div>' +
      '<div class="browse-footer" id="browse-footer"></div>' +
      '</main>' +
      '<button type="button" class="backtop" id="backtop" aria-label="回到顶部" title="回到顶部" hidden>' +
      icon('up') +
      '</button>'

    var grid = document.getElementById('browse-grid')
    var state = document.getElementById('browse-state')
    var footer = document.getElementById('browse-footer')
    var typeBox = document.getElementById('browse-types')
    var subBox = document.getElementById('browse-subs')
    var titleBox = document.getElementById('browse-title')
    if (!grid || !state || !footer || !typeBox || !subBox || !titleBox) return

    var categories = []
    var tops = []
    var selection = { topId: null, subId: null }
    var filterCat = ''
    /** 切换分类时递增：旧请求的响应直接丢弃 */
    var generation = 0
    var page = 0
    var loading = false
    var failed = false
    var exhausted = false
    var itemCount = 0
    var seen = Object.create(null)
    var fillFrame = 0
    var scrollFrame = 0

    var findCategory = function (id) {
      for (var index = 0; index < categories.length; index += 1) {
        if (categories[index].id === id) return categories[index]
      }
      return null
    }

    var subsOf = function (topId) {
      return sortCategories(
        categories.filter(function (row) {
          return row.parentId === topId
        })
      )
    }

    var clearState = function () {
      state.hidden = true
      state.innerHTML = ''
    }

    var showState = function (options) {
      grid.innerHTML = ''
      state.hidden = false
      state.innerHTML = stateBoxHtml({
        icon: options.icon || 'film',
        title: options.title,
        desc: options.desc || '',
        action: options.actionId
          ? { id: options.actionId, label: options.actionLabel || '重新加载' }
          : null
      })
      if (!options.actionId) return
      var button = document.getElementById(options.actionId)
      if (button) button.addEventListener('click', options.onAction || renderRoute)
    }

    var showEmpty = function () {
      if (filterCat) {
        showState({
          icon: 'film',
          title: '这个分类下还没有视频',
          desc: '换一个类型看看，或者去映盒剧场控制台采集一些视频。',
          actionId: 'browse-all',
          actionLabel: '看看全部视频',
          onAction: function () {
            select({ topId: null, subId: null })
          }
        })
        return
      }
      showState({
        icon: 'film',
        title: '片库里还没有视频',
        desc: '先在映盒剧场控制台采集一些视频，再回到这里刷新。',
        actionId: 'browse-reload',
        actionLabel: '重新加载',
        onAction: function () {
          startFilter(filterCat)
        }
      })
    }

    var updateFooter = function () {
      if (failed && itemCount > 0) {
        footer.innerHTML =
          '<button type="button" class="ghost-btn" id="browse-retry">加载失败，点击重试</button>'
        var retry = document.getElementById('browse-retry')
        if (retry) {
          retry.addEventListener('click', function () {
            failed = false
            void loadPage(page + 1, true)
          })
        }
        return
      }
      if (loading && itemCount > 0) {
        footer.innerHTML =
          '<span class="browse-foot-text"><span class="spinner is-small"></span>正在加载…</span>'
        return
      }
      if (exhausted && itemCount > 0) {
        footer.innerHTML = '<span class="browse-foot-text">已经全部加载</span>'
        return
      }
      footer.innerHTML = ''
    }

    var maybeFill = function () {
      if (loading || failed || exhausted || itemCount === 0) return
      if (grid.getBoundingClientRect().bottom - window.innerHeight < BROWSE_LOAD_AHEAD) {
        void loadPage(page + 1, true)
      }
    }

    var scheduleFill = function () {
      if (fillFrame) return
      fillFrame = window.requestAnimationFrame(function () {
        fillFrame = 0
        maybeFill()
      })
    }

    var loadPage = function (nextPage, append) {
      if (loading || exhausted) return
      loading = true
      failed = false
      var myGeneration = generation
      if (!append) {
        itemCount = 0
        seen = Object.create(null)
        grid.innerHTML = posterSkeletons(9)
        clearState()
      }
      updateFooter()
      getJson('/api/browse', { cat: filterCat, page: nextPage, pageSize: BROWSE_SIZE })
        .then(function (data) {
          if (token !== renderSeq || myGeneration !== generation) return
          var items = Array.isArray(data.items) ? data.items : []
          // 采集 / 隐藏会让 offset 分页错位，按视频 id 去重
          var fresh = items.filter(function (item) {
            var key = String(item.id)
            if (seen[key]) return false
            seen[key] = true
            return true
          })
          if (!append) grid.innerHTML = ''
          if (fresh.length > 0) {
            appendHtml(grid, fresh.map(posterCardHtml).join(''), fresh)
          }
          itemCount += fresh.length
          page = nextPage
          // 不统计总数：这一页不满 30 条就是到底
          exhausted = items.length < BROWSE_SIZE
          if (itemCount === 0) showEmpty()
        })
        .catch(function (error) {
          if (token !== renderSeq || myGeneration !== generation) return
          failed = true
          if (itemCount === 0) {
            showState({
              icon: 'film',
              title: '读取片库失败',
              desc: errorText(error, '片库可能正在初始化，请稍后重试。'),
              actionId: 'browse-reload',
              actionLabel: '重新加载',
              onAction: function () {
                startFilter(filterCat)
              }
            })
          }
        })
        .finally(function () {
          if (token !== renderSeq || myGeneration !== generation) return
          loading = false
          updateFooter()
          scheduleFill()
        })
    }

    var startFilter = function (cat) {
      filterCat = cat
      generation += 1
      page = 0
      loading = false
      failed = false
      exhausted = false
      itemCount = 0
      seen = Object.create(null)
      clearState()
      grid.innerHTML = posterSkeletons(9)
      footer.innerHTML = ''
      void loadPage(1, false)
    }

    var paintTitle = function () {
      var top = selection.topId ? findCategory(selection.topId) : null
      var sub = selection.subId ? findCategory(selection.subId) : null
      if (!top) {
        titleBox.textContent = '全部视频'
      } else if (!sub) {
        titleBox.textContent = top.name
      } else {
        titleBox.innerHTML =
          '<span class="browse-title-parent">' +
          esc(top.name) +
          '</span><span class="browse-title-sep">/</span>' +
          esc(sub.name)
      }
      var label = !top ? '全部视频' : !sub ? top.name : top.name + ' / ' + sub.name
      document.title = label + ' · ' + APP_TITLE
    }

    var chipHtml = function (label, active, attribute) {
      return (
        '<button type="button" class="browse-chip' +
        (active ? ' is-active' : '') +
        '" aria-pressed="' +
        active +
        '" ' +
        attribute +
        '>' +
        esc(label) +
        '</button>'
      )
    }

    var paintChips = function () {
      typeBox.hidden = tops.length === 0
      typeBox.innerHTML =
        chipHtml('全部', selection.topId === null, 'data-all="1"') +
        tops
          .map(function (top) {
            return chipHtml(top.name, selection.topId === top.id, 'data-top="' + esc(top.id) + '"')
          })
          .join('')
      var subs = selection.topId ? subsOf(selection.topId) : []
      subBox.hidden = subs.length === 0
      subBox.innerHTML =
        subs.length === 0
          ? ''
          : chipHtml('全部', selection.subId === null, 'data-sub=""') +
            subs
              .map(function (sub) {
                return chipHtml(
                  sub.name,
                  selection.subId === sub.id,
                  'data-sub="' + esc(sub.id) + '"'
                )
              })
              .join('')
    }

    var syncHash = function () {
      var cat = selection.subId || selection.topId || ''
      var next = '#/browse' + (cat ? '?cat=' + encodeURIComponent(cat) : '')
      try {
        window.history.replaceState(null, '', next)
      } catch (error) {
        // 个别内嵌浏览器不支持 replaceState：地址栏不同步，但不影响使用
      }
    }

    var select = function (next) {
      if (selection.topId === next.topId && selection.subId === next.subId) return
      selection = next
      syncHash()
      paintTitle()
      paintChips()
      window.scrollTo(0, 0)
      startFilter(next.subId || next.topId || '')
    }

    typeBox.addEventListener('click', function (event) {
      var button = closestFrom(event, 'button')
      if (!button) return
      if (button.hasAttribute('data-all')) {
        select({ topId: null, subId: null })
        return
      }
      var topId = button.getAttribute('data-top')
      if (topId) select({ topId: topId, subId: null })
    })

    subBox.addEventListener('click', function (event) {
      var button = closestFrom(event, 'button')
      if (!button || !button.hasAttribute('data-sub') || !selection.topId) return
      select({ topId: selection.topId, subId: button.getAttribute('data-sub') || null })
    })

    var syncChrome = function () {
      var y = window.scrollY || window.pageYOffset || 0
      var head = document.getElementById('browse-head')
      if (head) head.classList.toggle('is-compact', y > 96)
      var backtop = document.getElementById('backtop')
      if (backtop) {
        var show = y > BACK_TOP_AT
        backtop.hidden = !show
        backtop.classList.toggle('is-show', show)
      }
    }

    var onScroll = function () {
      if (scrollFrame) return
      scrollFrame = window.requestAnimationFrame(function () {
        scrollFrame = 0
        syncChrome()
        maybeFill()
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })

    var backtop = document.getElementById('backtop')
    if (backtop) {
      backtop.addEventListener('click', function () {
        var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
      })
    }

    setCleanup(function () {
      window.removeEventListener('scroll', onScroll)
      if (fillFrame) window.cancelAnimationFrame(fillFrame)
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
    })

    getJson('/api/categories')
      .then(function (data) {
        if (token !== renderSeq) return
        categories = Array.isArray(data.categories) ? data.categories : []
        tops = sortCategories(
          categories.filter(function (row) {
            return row.parentId === null
          })
        )
        if (tops.length === 0) {
          showState({
            icon: 'film',
            title: '还没有可展示的视频分类',
            desc: '去映盒剧场控制台的「分类」建好分类并绑定在线分类后，这里就会出现。',
            actionId: 'browse-reload',
            actionLabel: '重新加载',
            onAction: function () {
              renderRoute()
            }
          })
          return
        }
        selection = resolveBrowseSelection(categories, initialCat)
        // 链接里的分类失效时顺手把地址栏改回「全部」
        syncHash()
        paintTitle()
        paintChips()
        startFilter(selection.subId || selection.topId || '')
      })
      .catch(function (error) {
        if (token !== renderSeq) return
        showState({
          icon: 'film',
          title: '分类读取失败',
          desc: errorText(error, '分类数据可能正在初始化，稍后再试一次。'),
          actionId: 'browse-reload',
          actionLabel: '重新加载',
          onAction: function () {
            renderRoute()
          }
        })
      })
  }

  /* ── 搜索结果 ── */

  function resultRowHtml(item, keyword) {
    var extras = []
    if (item.intro) {
      extras.push('<span class="result-intro">' + esc(item.intro) + '</span>')
    }
    if (item.vodActor) {
      extras.push('<span class="result-actor">主演：' + esc(item.vodActor) + '</span>')
    }
    return (
      '<a class="result-row" href="#/play/' +
      item.id +
      '">' +
      coverHtml(item, 'row') +
      '<span class="result-body"><span class="result-title">' +
      highlight(item.name, keyword) +
      '</span><span class="result-meta">' +
      esc(metaLine(item)) +
      '</span>' +
      extras.join('') +
      '</span>' +
      '<span class="result-go" aria-hidden="true">' +
      icon('chevron') +
      '</span></a>'
    )
  }

  function renderSearch(route, token) {
    var keyword = String(route.params.get('q') || '')
      .trim()
      .slice(0, 60)
    var mode = route.params.get('mode') === 'online' ? 'online' : 'local'
    if (!keyword) {
      navigate('/')
      return
    }
    modeValue = mode
    storeMode(mode)
    document.title = keyword + ' · ' + APP_TITLE
    app.innerHTML =
      topbarHtml({ back: true }) +
      '<main class="page page-search">' +
      searchPanelHtml(keyword, mode) +
      '<div id="result-summary"></div><div id="site-report"></div>' +
      '<div class="result-list" id="result-list">' +
      rowSkeletons(5) +
      '</div><div id="load-more-wrap"></div>' +
      '<footer class="page-foot"><span><strong>映盒剧场</strong> · 局域网影院</span><span>内容来自本片库 · 请在同一局域网内使用</span></footer>' +
      '</main>'
    bindBack()
    bindSearch({
      mode: mode,
      onSubmit: function (word, nextMode) {
        navigate('/search?q=' + encodeURIComponent(word) + '&mode=' + nextMode)
      },
      onModeChange: function (nextMode, currentText) {
        var word = currentText || keyword
        if (word) navigate('/search?q=' + encodeURIComponent(word) + '&mode=' + nextMode)
      }
    })

    var list = document.getElementById('result-list')
    var summary = document.getElementById('result-summary')
    var report = document.getElementById('site-report')
    var moreWrap = document.getElementById('load-more-wrap')
    if (!list) return

    var page = 1
    var itemCount = 0
    var total = 0
    var loading = false
    var exhausted = false
    var seenIds = Object.create(null)

    var updateMore = function () {
      if (!moreWrap) return
      if (exhausted || itemCount === 0) {
        moreWrap.innerHTML = ''
        return
      }
      moreWrap.innerHTML =
        '<div class="load-more"><button type="button" class="ghost-btn" id="load-more"' +
        (loading ? ' disabled' : '') +
        '>' +
        (loading ? '正在加载…' : '加载更多') +
        '</button></div>'
      var button = document.getElementById('load-more')
      if (button) {
        button.addEventListener('click', function () {
          if (!loading) void load(page + 1, true)
        })
      }
    }

    var setSummary = function (data) {
      if (!summary) return
      var sites = Array.isArray(data.sites) ? data.sites : []
      if (mode === 'online') {
        var failed = sites.filter(function (site) {
          return !site.ok
        }).length
        var tags = ['<span class="summary-tag is-online">' + icon('wifi') + ' 在线检索</span>']
        if (data.siteCount) {
          tags.push(
            '<span class="summary-tag">' + formatCount(data.siteCount) + ' 个站点参与</span>'
          )
        } else {
          tags.push('<span class="summary-tag">没有可用站点</span>')
        }
        if (data.queued) {
          tags.push(
            '<span class="summary-tag">已触发 ' + formatCount(data.queued) + ' 个后台任务</span>'
          )
        }
        if (data.truncated) tags.push('<span class="summary-tag">结果较多，只显示前 200 条</span>')
        summary.innerHTML =
          '<strong>' + formatCount(data.total || 0) + '</strong><span>条结果</span>' + tags.join('')
        if (report && sites.length > 0) {
          var rows = sites
            .map(function (site) {
              var name = site.siteName || site.siteId || '站点'
              var detail = site.ok
                ? site.recordCount > site.count
                  ? '返回 ' +
                    formatCount(site.count) +
                    ' 条，站点报告共 ' +
                    formatCount(site.recordCount) +
                    ' 条'
                  : '返回 ' + formatCount(site.count) + ' 条'
                : '请求失败（' + esc(site.error || '未知错误') + '）'
              return (
                '<li class="' +
                (site.ok ? '' : 'is-failed') +
                '">' +
                esc(name) +
                '：' +
                detail +
                '</li>'
              )
            })
            .join('')
          report.innerHTML =
            '<details class="site-report"><summary>分站结果（' +
            formatCount(sites.length - failed) +
            ' / ' +
            formatCount(sites.length) +
            ' 成功）</summary><ul>' +
            rows +
            '</ul></details>'
        }
        return
      }
      summary.innerHTML =
        '<strong>' +
        formatCount(data.total || 0) +
        '</strong><span>条结果</span><span class="summary-tag">本地片库</span>'
    }

    var load = function (nextPage, append) {
      if (loading) return
      loading = true
      if (!append) {
        list.innerHTML = rowSkeletons(5)
        if (summary) {
          summary.innerHTML =
            '<span class="summary-tag">' +
            (mode === 'online' ? '正在检索在线站点…' : '正在检索…') +
            '</span>'
        }
        if (report) report.innerHTML = ''
        if (moreWrap) moreWrap.innerHTML = ''
      } else if (moreWrap) {
        moreWrap.innerHTML =
          '<div class="load-more"><button type="button" class="ghost-btn" disabled>正在加载…</button></div>'
      }

      getJson('/api/search', {
        q: keyword,
        mode: mode,
        page: nextPage,
        pageSize: PAGE_SIZE
      })
        .then(function (data) {
          if (token !== renderSeq) return
          var items = Array.isArray(data.items) ? data.items : []
          // 采集 / 删除会让 offset 分页错位，按视频 id 去重，避免同一行出现两次
          var fresh = items.filter(function (item) {
            var key = String(item.id)
            if (seenIds[key]) return false
            seenIds[key] = true
            return true
          })
          page = nextPage
          if (!append) list.innerHTML = ''
          if (fresh.length === 0 && !append) {
            list.innerHTML = stateBoxHtml({
              icon: 'search',
              title: '没有找到相关视频',
              desc:
                mode === 'online'
                  ? '换一个关键词试试，或者切到本地片库。'
                  : '换一个关键词试试，片名里可能没有这几个字。'
            })
          } else {
            appendHtml(
              list,
              fresh
                .map(function (item) {
                  return resultRowHtml(item, keyword)
                })
                .join(''),
              fresh
            )
          }
          itemCount += fresh.length
          total = Number(data.total) || itemCount
          setSummary(data)
          var size = Number(data.pageSize) || PAGE_SIZE
          if (mode === 'online') exhausted = true
          else exhausted = items.length < size || (total > 0 && itemCount >= total)
          updateMore()
        })
        .catch(function (error) {
          if (token !== renderSeq) return
          if (!append) list.innerHTML = ''
          list.insertAdjacentHTML(
            'afterbegin',
            stateBoxHtml({
              icon: 'search',
              title: '检索失败',
              desc: errorText(error, '请稍后重试'),
              action: { id: 'retry-search', label: '重新检索' }
            })
          )
          var retry = document.getElementById('retry-search')
          if (retry) {
            retry.addEventListener('click', function () {
              void load(1, false)
            })
          }
          if (summary) summary.innerHTML = ''
          if (report) report.innerHTML = ''
        })
        .finally(function () {
          loading = false
          if (token === renderSeq) updateMore()
        })
    }

    void load(1, false)
  }

  /* ── 播放页 ── */

  function episodeLabel(name, index) {
    var text = String(name || '').trim()
    var numbered = text.match(/第\s*(\d+)\s*[集话期回]/)
    var plain = text.match(/^(\d+)$/)
    var digits = (numbered && numbered[1]) || (plain && plain[1]) || ''
    if (digits) return { number: String(Number(digits)).padStart(2, '0'), caption: '' }
    return { number: String(index + 1).padStart(2, '0'), caption: text }
  }

  function renderPlay(route, token) {
    document.title = '播放 · ' + APP_TITLE
    app.innerHTML =
      topbarHtml({ back: true }) +
      '<main class="page page-play"><div class="state-box" id="play-loading"><span class="spinner"></span><p>正在读取播放信息…</p></div></main>'
    bindBack()
    getJson('/api/video/' + route.id)
      .then(function (data) {
        if (token !== renderSeq) return
        if (!data.video) throw new Error('NOT_FOUND')
        renderPlayDetail(route, data.video)
      })
      .catch(function (error) {
        if (token !== renderSeq) return
        app.innerHTML =
          topbarHtml({ back: true }) +
          '<main class="page page-play">' +
          stateBoxHtml({
            icon: 'film',
            title: '无法打开这个视频',
            desc: errorText(error, '它可能已经被删除，或者片库正在清理缓存。'),
            action: { id: 'play-back', label: '回到首页' }
          }) +
          '</main>'
        bindBack()
        var button = document.getElementById('play-back')
        if (button) {
          button.addEventListener('click', function () {
            navigate('/')
          })
        }
      })
  }

  function renderPlayDetail(route, video) {
    var lines = []
    ;(video.sources || []).forEach(function (source) {
      ;(source.lines || []).forEach(function (line, lineIndex) {
        // 网页播放器只认 m3u8：mp4 / flv / 分享页这类直链直接不显示
        var episodes = (line.episodes || []).filter(function (episode) {
          return safeUrl(episode.url) && isHls(episode.url)
        })
        if (episodes.length === 0) return
        lines.push({
          key: String(source.id) + '-' + lineIndex,
          sourceName: source.siteName || '来源',
          flag: line.flag || '默认线路',
          episodes: episodes
        })
      })
    })

    if (lines.length === 0) {
      app.innerHTML =
        topbarHtml({ back: true }) +
        '<main class="page page-play">' +
        stateBoxHtml({
          icon: 'film',
          title: '这个视频还没有 m3u8 线路',
          desc: '采集站暂时没有提供可播放的 m3u8 地址，可以过一会儿再试。',
          action: { id: 'play-back', label: '回到首页' }
        }) +
        '</main>'
      bindBack()
      var backButton = document.getElementById('play-back')
      if (backButton) {
        backButton.addEventListener('click', function () {
          navigate('/')
        })
      }
      return
    }

    var requestedKey = route.params.get('line') || ''
    var requestedEpRaw = route.params.get('ep')
    var requestedEp = requestedEpRaw === null ? 0 : Number(requestedEpRaw)
    var line = lines.find(function (item) {
      return item.key === requestedKey
    })
    if (!line) line = lines[0]
    var index =
      Number.isInteger(requestedEp) && requestedEp >= 0 && requestedEp < line.episodes.length
        ? requestedEp
        : 0
    var autoNext = readAutoNext()
    var poster = picOf(video)
    var intro = String(video.intro || '')
    var metaParts = unique([
      video.note,
      video.year,
      video.area,
      video.vodClass,
      video.sourceCount ? video.sourceCount + ' 个站点来源' : ''
    ])
    var infoRows = []
    if (video.vodActor) {
      infoRows.push('<div><dt>主演</dt><dd>' + esc(video.vodActor) + '</dd></div>')
    }
    if (video.vodClass) {
      infoRows.push('<div><dt>类型</dt><dd>' + esc(video.vodClass) + '</dd></div>')
    }
    if (video.year || video.area) {
      infoRows.push(
        '<div><dt>年份</dt><dd>' + esc(unique([video.year, video.area]).join(' · ')) + '</dd></div>'
      )
    }
    infoRows.push(
      '<div><dt>来源</dt><dd>' +
        esc(video.sourceCount ? video.sourceCount + ' 个站点' : '—') +
        '</dd></div>'
    )

    app.innerHTML =
      topbarHtml({ back: true }) +
      '<main class="page page-play"><div class="play-layout"><div class="play-main">' +
      '<div class="stage" id="stage">' +
      '<video id="video" controls playsinline webkit-playsinline preload="metadata"' +
      (poster ? ' poster="' + esc(poster) + '"' : '') +
      '></video>' +
      '<div class="stage-spinner" id="stage-spinner"><span class="spinner"></span></div>' +
      '<div class="stage-error" id="stage-error" hidden><p id="stage-error-text"></p><button type="button" class="ghost-btn" id="retry-btn">重新加载</button></div>' +
      '</div>' +
      '<div class="play-head"><div><h1>' +
      esc(video.name) +
      '</h1><p class="play-sub" id="play-sub">' +
      esc(metaParts.join(' · ')) +
      '</p></div><div class="play-actions"><button type="button" class="ghost-btn" id="reload-btn">' +
      icon('refresh') +
      ' 刷新</button></div></div>' +
      (intro
        ? '<div class="play-intro"><h2>简介</h2><p class="intro-text' +
          (intro.length > 120 ? ' is-clamped' : '') +
          '" id="intro-text">' +
          esc(intro) +
          '</p>' +
          (intro.length > 120
            ? '<button type="button" class="intro-toggle" id="intro-toggle">展开</button>'
            : '') +
          '</div>'
        : '') +
      '</div><aside class="play-side">' +
      '<section class="panel"><div class="panel-head"><h2>线路</h2><span>' +
      formatCount(lines.length) +
      ' 条 · 仅 m3u8</span></div><div class="line-list" id="line-list"></div></section>' +
      '<section class="panel"><div class="panel-head"><h2>选集</h2><span id="ep-count"></span></div><div class="episode-grid" id="episode-grid"></div></section>' +
      '<label class="switch-row"><span>自动连播</span><input type="checkbox" id="auto-next"' +
      (autoNext ? ' checked' : '') +
      ' /><i class="switch"></i></label>' +
      '<section class="panel"><div class="panel-head"><h2>信息</h2></div><dl class="info-list">' +
      infoRows.join('') +
      '</dl></section>' +
      '</aside></div></main>'

    bindBack()

    var videoEl = document.getElementById('video')
    var spinner = document.getElementById('stage-spinner')
    var errorBox = document.getElementById('stage-error')
    var errorTextEl = document.getElementById('stage-error-text')
    var lineList = document.getElementById('line-list')
    var episodeGrid = document.getElementById('episode-grid')
    var playSub = document.getElementById('play-sub')
    if (!videoEl || !lineList || !episodeGrid) return

    var hls = null
    var loadToken = 0
    var failureCount = 0

    var lineLabel = function (item) {
      var base = item.flag || '默认线路'
      var count = lines.filter(function (other) {
        return (other.flag || '默认线路') === base
      }).length
      return count > 1 ? item.sourceName + ' · ' + base : base
    }

    var showSpinner = function (show) {
      if (spinner) spinner.hidden = !show
    }

    var hideError = function () {
      if (errorBox) errorBox.hidden = true
    }

    var showError = function (message) {
      if (errorTextEl) errorTextEl.textContent = message
      if (errorBox) errorBox.hidden = false
      showSpinner(false)
    }

    var updateHash = function () {
      var next =
        '#/play/' + video.id + '?line=' + encodeURIComponent(line.key) + '&ep=' + String(index)
      try {
        window.history.replaceState(null, '', next)
      } catch (error) {
        // 某些内嵌浏览器不支持 replaceState，忽略即可
      }
    }

    var updateSubtitle = function () {
      var episode = line.episodes[index]
      var extra = unique([video.note, episode && episode.name]).join(' · ')
      if (playSub) playSub.textContent = extra || metaParts.join(' · ')
      document.title =
        video.name + (episode && episode.name ? ' · ' + episode.name : '') + ' · ' + APP_TITLE
    }

    var paintLines = function () {
      lineList.innerHTML = lines
        .map(function (item) {
          return (
            '<button type="button" class="chip' +
            (item.key === line.key ? ' is-active' : '') +
            '" data-line="' +
            esc(item.key) +
            '">' +
            esc(lineLabel(item)) +
            '</button>'
          )
        })
        .join('')
    }

    var paintEpisodes = function () {
      episodeGrid.innerHTML = line.episodes
        .map(function (episode, epIndex) {
          var label = episodeLabel(episode.name, epIndex)
          return (
            '<button type="button" class="episode' +
            (epIndex === index ? ' is-active' : '') +
            '" data-ep="' +
            epIndex +
            '" title="' +
            esc(episode.name || '') +
            '"><span>' +
            label.number +
            '</span>' +
            (label.caption ? '<small>' + esc(label.caption) + '</small>' : '') +
            '</button>'
          )
        })
        .join('')
      var count = document.getElementById('ep-count')
      if (count) count.textContent = formatCount(line.episodes.length) + ' 集'
      var active = episodeGrid.querySelector('.episode.is-active')
      if (active) {
        episodeGrid.scrollTop = Math.max(0, active.offsetTop - episodeGrid.offsetTop - 40)
      }
    }

    var playVideo = function () {
      var result = videoEl.play()
      if (result && typeof result.catch === 'function') {
        result.catch(function () {
          // 浏览器拦截自动播放时，用户点播放键即可
        })
      }
    }

    var loadHls = function () {
      if (window.Hls) return Promise.resolve(window.Hls)
      if (hlsPromise) return hlsPromise
      hlsPromise = new Promise(function (resolve) {
        var script = document.createElement('script')
        script.src = HLS_SCRIPT
        script.async = true
        script.onload = function () {
          if (window.Hls) {
            resolve(window.Hls)
          } else {
            hlsPromise = null
            resolve(null)
          }
        }
        script.onerror = function () {
          hlsPromise = null
          resolve(null)
        }
        document.head.appendChild(script)
      })
      return hlsPromise
    }

    var loadEpisode = function (autoplay) {
      var currentToken = ++loadToken
      var episode = line.episodes[index]
      if (!episode) return
      hideError()
      showSpinner(true)
      if (hls) {
        try {
          hls.destroy()
        } catch (error) {
          // 已销毁
        }
        hls = null
      }
      videoEl.pause()
      videoEl.removeAttribute('src')
      videoEl.load()
      updateSubtitle()
      if (!isHls(episode.url)) {
        showError('这条线路不是 m3u8，暂时无法播放。')
        return
      }
      var src = '/api/play.m3u8?u=' + encodeURIComponent(episode.url)
      // 注意：Chromium 对 canPlayType('application/vnd.apple.mpegurl') 也返回 'maybe'，
      // 但实际播不了 HLS，所以先用 hls.js 的 MSE 能力判断，原生 HLS 只做兜底。
      loadHls().then(function (Hls) {
        if (currentToken !== loadToken) return
        if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
          var instance = new Hls({ enableWorker: true, backBufferLength: 90 })
          hls = instance
          instance.on(Hls.Events.MANIFEST_PARSED, function () {
            if (currentToken !== loadToken) return
            showSpinner(false)
            if (autoplay) playVideo()
          })
          instance.on(Hls.Events.ERROR, function (_event, data) {
            if (currentToken !== loadToken || !data || !data.fatal) return
            if (failureCount < 1) {
              failureCount += 1
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                instance.startLoad()
                return
              }
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                instance.recoverMediaError()
                return
              }
            }
            showError('这条线路播放失败，换一条线路或稍后重试。')
          })
          instance.attachMedia(videoEl)
          instance.on(Hls.Events.MEDIA_ATTACHED, function () {
            if (currentToken === loadToken) instance.loadSource(src)
          })
          return
        }
        if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = src
          videoEl.load()
          if (autoplay) playVideo()
          return
        }
        showError('当前浏览器不支持 HLS 播放，请使用 Safari 或新版 Chrome。')
      })
    }

    videoEl.addEventListener('loadedmetadata', function () {
      showSpinner(false)
    })
    videoEl.addEventListener('playing', function () {
      hideError()
      showSpinner(false)
    })
    videoEl.addEventListener('waiting', function () {
      if (!videoEl.paused) showSpinner(true)
    })
    videoEl.addEventListener('error', function () {
      if (!videoEl.currentSrc) return
      showError('视频加载失败，可能是线路失效或网络异常。')
    })
    videoEl.addEventListener('ended', function () {
      if (!autoNext || index + 1 >= line.episodes.length) return
      index += 1
      paintEpisodes()
      updateHash()
      failureCount = 0
      loadEpisode(true)
    })

    lineList.addEventListener('click', function (event) {
      var button = closestFrom(event, 'button[data-line]')
      if (!button) return
      var next = lines.find(function (item) {
        return item.key === button.dataset.line
      })
      if (!next || next === line) return
      line = next
      index = 0
      failureCount = 0
      paintLines()
      paintEpisodes()
      updateHash()
      loadEpisode(true)
    })

    episodeGrid.addEventListener('click', function (event) {
      var button = closestFrom(event, 'button[data-ep]')
      if (!button) return
      var next = Number(button.dataset.ep)
      if (!Number.isInteger(next) || next < 0 || next >= line.episodes.length) return
      if (next === index) return
      index = next
      failureCount = 0
      paintEpisodes()
      updateHash()
      loadEpisode(true)
    })

    var autoNextInput = document.getElementById('auto-next')
    if (autoNextInput) {
      autoNextInput.addEventListener('change', function () {
        autoNext = autoNextInput.checked
        storeAutoNext(autoNext)
      })
    }

    var retryButton = document.getElementById('retry-btn')
    if (retryButton) {
      retryButton.addEventListener('click', function () {
        failureCount = 0
        loadEpisode(true)
      })
    }
    var reloadButton = document.getElementById('reload-btn')
    if (reloadButton) {
      reloadButton.addEventListener('click', function () {
        failureCount = 0
        loadEpisode(true)
        showToast('正在重新加载播放线路')
      })
    }

    var introText = document.getElementById('intro-text')
    var introToggle = document.getElementById('intro-toggle')
    if (introText && introToggle) {
      introToggle.addEventListener('click', function () {
        var clamped = introText.classList.toggle('is-clamped')
        introToggle.textContent = clamped ? '展开' : '收起'
      })
    }

    setCleanup(function () {
      loadToken += 1
      if (hls) {
        try {
          hls.destroy()
        } catch (error) {
          // 已销毁
        }
        hls = null
      }
      try {
        videoEl.pause()
      } catch (error) {
        // 忽略
      }
      videoEl.removeAttribute('src')
      videoEl.load()
    })

    paintLines()
    paintEpisodes()
    updateSubtitle()
    loadEpisode(true)
  }

  function renderNotFound() {
    document.title = '页面不存在 · ' + APP_TITLE
    app.innerHTML =
      topbarHtml() +
      '<main class="page">' +
      stateBoxHtml({
        icon: 'film',
        title: '页面不存在',
        desc: '这个地址没有对应的内容。',
        action: { id: 'go-home', label: '回到首页' }
      }) +
      '</main>'
    var button = document.getElementById('go-home')
    if (button) {
      button.addEventListener('click', function () {
        navigate('/')
      })
    }
  }

  window.addEventListener('hashchange', renderRoute)
  renderRoute()
})()
