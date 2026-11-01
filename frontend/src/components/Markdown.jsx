import { useEffect, useId, useRef, useState } from 'react'
import { Fragment } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import Icon from './ui/Icon.jsx'
import 'highlight.js/styles/github-dark.css'

let mermaidPromise

function loadMermaid() {
  mermaidPromise ||= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      flowchart: { htmlLabels: false, curve: 'linear', nodeSpacing: 36, rankSpacing: 40 },
      themeVariables: {
        background: 'transparent',
        primaryColor: '#1b1c20',
        primaryTextColor: '#f5f5f5',
        primaryBorderColor: '#3f3f46',
        lineColor: '#a1a1aa',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      },
    })
    return mermaid
  })
  return mermaidPromise
}

function plainText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (node && typeof node === 'object' && 'props' in node) return plainText(node.props.children)
  return ''
}

function parseAsciiFlow(source) {
  const nodes = []
  let insideBox = false
  let current = null

  for (const line of source.split(/\r?\n/)) {
    if (/^\s*[+┌╭┏╔][─━═-]+[+┐╮┓╗]\s*$/.test(line)) {
      if (current?.label) nodes.push(current)
      current = { label: '', description: '' }
      insideBox = true
      continue
    }

    if (insideBox) {
      if (/^\s*[+└╰┗╚][─━═-]+[+┘╯┛╝]\s*$/.test(line)) {
        if (current?.label) nodes.push(current)
        current = null
        insideBox = false
        continue
      }

      const content = /^\s*[│|](.*?)[│|]\s*(.*)$/.exec(line)
      if (!content) continue
      const label = content[1].trim()
      const description = content[2].replace(/^[\s←→↔⇢➜:—–>-]+/, '').trim()
      if (label && !current.label) current.label = label
      if (description && !current.description) current.description = description
    }
  }

  if (current?.label) nodes.push(current)
  return nodes.length >= 3 ? nodes : null
}

function DiagramArrow() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="my-4 h-4 w-4 text-neutral-500">
      <path d="M12 4v15m-5-5 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ArchitectureFlow({ nodes }) {
  return (
    <div className="my-5 overflow-hidden rounded-2xl border border-white/10 bg-[#111214] px-4 py-7 sm:px-6">
      <ol className="mx-auto flex max-w-xl flex-col items-center text-center">
        {nodes.map((node, index) => (
          <li key={`${node.label}-${index}`} className="flex w-full flex-col items-center">
            <Icon
              name={/screen|video|capture|camera/i.test(node.label) ? 'computer' : /detect|vision|scan/i.test(node.label) ? 'target' : /decision|engine|model|ai/i.test(node.label) ? 'sparkles' : /controller|device|android|input/i.test(node.label) ? 'device' : 'code'}
              size={20}
              className="mb-3 text-neutral-300"
            />
            <p className="text-sm font-semibold leading-6 text-neutral-100">
              {index + 1}. {node.label}
            </p>
            {node.description && (
              <p className="mt-0.5 max-w-prose text-sm leading-6 text-neutral-400">{node.description}</p>
            )}
            {index < nodes.length - 1 && <DiagramArrow />}
          </li>
        ))}
      </ol>
    </div>
  )
}

function webUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function RecommendationCard({ item, index }) {
  const [imageFailed, setImageFailed] = useState(false)
  const url = webUrl(item.url)
  const image = webUrl(item.image)

  return (
    <article className="flex gap-3 border-b border-white/[0.08] py-4 last:border-0 last:pb-0 first:pt-0 sm:gap-4">
      {image && !imageFailed && (
        <a
          href={url || image}
          target="_blank"
          rel="noreferrer noopener"
          className="h-[76px] w-[96px] shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] sm:h-[84px] sm:w-[112px]"
          aria-label={`Open ${item.title}`}
          title={`Open ${item.title}`}
        >
          <img
            src={image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover"
          />
        </a>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold leading-6 text-neutral-100">
            {index + 1}. {item.title}
          </h3>
          {index === 0 && (
            <span className="rounded-full bg-indigo-400/15 px-2 py-0.5 text-[10px] font-semibold text-indigo-200">
              Best match
            </span>
          )}
        </div>
        {item.description && (
          <p className="mt-1 whitespace-pre-line text-sm leading-6 text-neutral-300">{item.description}</p>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-flex items-center gap-1 text-sm text-neutral-200 underline decoration-white/30 underline-offset-4 transition hover:text-white hover:decoration-white"
          >
            {item.linkLabel || 'Open official source'}
            <Icon name="external" size={13} />
          </a>
        )}
      </div>
    </article>
  )
}

function RecommendationList({ data }) {
  const title = typeof data.title === 'string' ? data.title.slice(0, 120) : 'Recommendations'
  const items = data.items
    .filter((item) => item && typeof item.title === 'string')
    .slice(0, 8)
    .map((item) => ({
      title: item.title.slice(0, 160),
      description: typeof item.description === 'string' ? item.description.slice(0, 1200) : '',
      url: typeof item.url === 'string' ? item.url : '',
      image: typeof item.image === 'string' ? item.image : '',
      linkLabel: typeof item.linkLabel === 'string' ? item.linkLabel.slice(0, 80) : '',
    }))

  if (!items.length) return null

  return (
    <section aria-label={title} className="my-5 min-w-0">
      <h2 className="mb-2 text-base font-semibold tracking-tight text-white">{title}</h2>
      {items.map((item, index) => <RecommendationCard key={`${item.title}-${index}`} item={item} index={index} />)}
    </section>
  )
}

function parseStatusMarkdown(text) {
  const lines = String(text || '').split(/\r?\n/)
  const tableStart = lines.findIndex((line, index) =>
    /^\s*\|.*\|\s*$/.test(line) && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1] || ''),
  )
  if (tableStart >= 0) {
    const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    const headers = splitRow(lines[tableStart]).map((cell) => cell.replace(/\*\*/g, '').toLowerCase())
    const statusIndex = headers.findIndex((header) => /\b(installed|available|status|present|detected)\b/.test(header))
    const versionIndex = headers.findIndex((header) => /\b(version|details|result)\b/.test(header))
    const labelIndex = headers.findIndex((header) => /\b(tool|name|item|requirement|check)\b/.test(header))
    if (statusIndex >= 0) {
      const rows = []
      for (const line of lines.slice(tableStart + 2)) {
        if (!/^\s*\|.*\|\s*$/.test(line)) break
        const cells = splitRow(line)
        if (cells.length < headers.length) continue
        const status = cells[statusIndex].replace(/\*\*/g, '').trim()
        const label = cells[labelIndex >= 0 ? labelIndex : 0].replace(/\*\*/g, '').trim()
        const version = versionIndex >= 0 ? cells[versionIndex].replace(/\*\*/g, '').trim() : ''
        if (!label) continue
        const negative = /\b(?:no|false|missing|not installed|not available|unavailable|failed|disconnected)\b|[❌✗]/i.test(status)
        const positive = /\b(?:yes|true|installed|available|present|detected|connected|ready|found)\b|[✅✔✓☑]/i.test(status)
        const statusLabel = /\bconnected\b/i.test(status)
          ? 'Connected'
          : /\binstalled\b/i.test(status) || /\binstalled\b/i.test(headers[statusIndex])
            ? 'Installed'
            : 'Available'
        rows.push({
          label,
          detail: version,
          negative,
          verified: positive || negative,
          connected: /\bconnected\b/i.test(status),
          status: positive || negative ? statusLabel : '',
        })
      }
      if (rows.length >= 2) {
        const before = lines.slice(0, tableStart)
          .filter((line) => !/^\s*(?:#{1,3}\s*)?(?:status\s+card|results?)\s*#*\s*$/i.test(line))
          .join(' ')
          .replace(/\*\*/g, '')
          .replace(/\bsummary\s*[—–:-]\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim()
        return { intro: before, checks: rows }
      }
    }
  }

  const firstBullet = lines.findIndex((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line))
  if (firstBullet < 0) return null

  const intro = lines.slice(0, firstBullet).join(' ').replace(/^#{1,3}\s+/, '').trim()
  if (!/\b(?:successfully|connected|installed|available|detected|verified|ready|check(?:ed)?|found)\b/i.test(intro)) return null

  const entries = []
  let current = null
  for (const line of lines.slice(firstBullet)) {
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line)
    if (bullet) {
      if (current) entries.push(current)
      current = { text: bullet[1] }
    } else if (current && line.trim()) {
      current.text += ` ${line.trim()}`
    } else if (!line.trim() && current) {
      entries.push(current)
      current = null
    }
  }
  if (current) entries.push(current)

  const checks = entries.map(({ text: rawText }) => {
    const explicitPositive = /^\s*(?:✅|✔|✓|🟢|\[x\]|\[X\])/.test(rawText)
    const explicitNegative = /^\s*(?:🔴|❌|\[ \])/.test(rawText)
    const textValue = rawText
      .replace(/^\s*(?:✅|✔|✓|🟢|🔴|❌)\s*/, '')
      .replace(/\[([ xX])\]\s*/, '')
      .trim()
    const labelMatch = /^\*\*(.+?)\*\*\s*(?:[—–-]\s*)?([\s\S]*)$/.exec(textValue)
    const label = labelMatch?.[1] || textValue
    const detail = labelMatch?.[2]?.replace(/\s+/g, ' ').trim() || ''
    const negative = /\b(?:not installed|not available|not found|missing|unavailable|failed|disconnected|error)\b/i.test(textValue)
    const connected = /\bconnected\b/i.test(`${label} ${detail}`)
    const positive = explicitPositive || /\b(?:installed|available|detected|found|connected|ready|verified|present|successfully)\b/i.test(textValue)
    const status = connected ? (negative ? 'Disconnected' : 'Connected') : /\binstalled\b/i.test(`${label} ${detail}`) ? 'Installed' : ''
    return { label, detail, negative: negative || explicitNegative, verified: positive || negative || explicitNegative, connected, status }
  })
  if (checks.length < 2 || !checks.some((check) => /\b(?:installed|available|detected|found|connected|missing|unavailable|not found|not installed)\b/i.test(`${check.label} ${check.detail}`))) {
    return null
  }
  return { intro, checks }
}

function StatusCheck({ negative = false, verified = true }) {
  const tone = negative
    ? 'bg-amber-500 text-[#17120a]'
    : verified
      ? 'bg-emerald-500 text-[#07140d]'
      : 'border border-neutral-600 text-neutral-500'
  return (
    <span className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full ${tone}`}>
      <Icon name={negative ? 'x' : verified ? 'check' : 'info'} size={negative || verified ? 11 : 12} strokeWidth={2.8} />
    </span>
  )
}

function StatusReport({ data }) {
  const [primary, ...remaining] = data.checks
  return (
    <div className="my-4 min-w-0">
      {data.intro && <p className="mb-3 break-words text-[15px] leading-7 text-neutral-200">{data.intro}</p>}
      <section aria-label="System check results" className="overflow-hidden rounded-2xl border border-white/[0.1] bg-white/[0.012] px-3 sm:px-4">
        <div className="flex items-center gap-3 py-4">
          <StatusCheck negative={primary.negative} verified={primary.verified} />
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-semibold leading-6 text-neutral-100">{primary.label}</p>
            {primary.detail && <p className="mt-0.5 break-words text-sm leading-5 text-neutral-400">{primary.detail}</p>}
          </div>
          {primary.status && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${primary.negative ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
              {primary.negative ? (primary.connected ? 'Disconnected' : 'Missing') : primary.status}
            </span>
          )}
        </div>
        {remaining.length > 0 && (
          <ul className="border-t border-white/[0.08] py-2.5">
            {remaining.map((check, index) => (
              <li key={`${check.label}-${index}`} className="flex items-center gap-3 py-2">
                <StatusCheck negative={check.negative} verified={check.verified} />
                <span className={`min-w-0 break-words text-sm leading-5 ${check.negative ? 'text-amber-200' : check.verified ? 'text-neutral-100' : 'text-neutral-400'}`}>
                  {check.label}{check.detail ? ` — ${check.detail}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function parseRecommendations(source) {
  try {
    const data = JSON.parse(source)
    return data && Array.isArray(data.items) ? data : null
  } catch (error) {
    console.error('Failed to parse the assistant recommendation list.', error)
    return null
  }
}

function parseRecommendationMarkdown(text) {
  const lines = String(text || '').split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => {
    const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]
    const boldHeading = /^\*\*(.+?)\*\*\s*$/.exec(line)?.[1]
    const plainHeading = line.trim().length <= 120 && !/^\s*(?:[-*+]|\d+[.)])\s/.test(line) ? line.trim() : ''
    return /\b(recommend(?:ation)?s?|resources?|top picks|best options|courses|tools|products)\b/i.test(heading || boldHeading || plainHeading)
  })
  if (headingIndex < 0) return null

  const heading =
    /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(lines[headingIndex]) ||
    /^\*\*(.+?)\*\*\s*$/.exec(lines[headingIndex]) ||
    [null, lines[headingIndex].trim()]
  const items = []
  let current = null

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^#{1,3}\s/.test(line)) break
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line)
    if (bullet) {
      if (current) items.push(current)
      current = { text: bullet[1] }
    } else if (current && line.trim()) {
      current.text += ` ${line.trim()}`
    } else if (current && !line.trim()) {
      const next = lines.slice(index + 1).find((nextLine) => nextLine.trim())
      if (!next || !/^\s*(?:[-*+]|\d+[.)])\s+/.test(next)) {
        items.push(current)
        current = null
      }
    }
  }
  if (current) items.push(current)

  const recommendations = items.map(({ text: itemText }) => {
    const titleMatch = /^\*\*(.+?)\*\*\s*(?:[—–-]\s*)?([\s\S]*)$/.exec(itemText)
    if (!titleMatch) return null
    const image =
      /!\[[^\]]*]\((https?:\/\/[^)\s]+)(?:\s+[^)]*)?\)/i.exec(itemText)?.[1] ||
      /\b(?:preview|image)\s+(?:image|preview):\s*(https?:\/\/[^\s)]+)/i.exec(itemText)?.[1]
    const links = [...itemText.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi)]
    const url = links[0]?.[2] || /(https?:\/\/[^\s)]+)/i.exec(itemText)?.[1] || ''
    let description = titleMatch[2]
      .replace(/!\[[^\]]*]\(https?:\/\/[^)\s]+(?:\s+[^)]*)?\)/gi, '')
      .replace(/\b(?:preview|image)\s+(?:image|preview):\s*https?:\/\/[^\s)]+/gi, '')
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/gi, '$1')
      .replace(/\s*(?:\*{1,2})?\s*Source:\s*.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    return {
      title: titleMatch[1],
      description,
      url,
      image,
      linkLabel: links[0]?.[1] || (url ? 'Open source' : ''),
    }
  }).filter(Boolean)

  if (recommendations.length < 2) return null
  return {
    before: lines.slice(0, headingIndex).join('\n').trim(),
    after: '',
    data: { title: heading?.[1] || 'Recommendations', items: recommendations },
  }
}

function MermaidDiagram({ source }) {
  const id = `antral-diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [rendered, setRendered] = useState(null)
  const svg = rendered?.source === source && !rendered.failed ? rendered.svg : ''
  const failed = rendered?.source === source && rendered.failed
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef(null)

  useEffect(() => {
    let cancelled = false
    loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then(({ svg: renderedSvg }) => {
        if (!cancelled) setRendered({ source, svg: renderedSvg, failed: false })
      })
      .catch((error) => {
        console.error('Failed to render an assistant-provided Mermaid diagram.', error)
        if (!cancelled) setRendered({ source, svg: '', failed: true })
      })
    return () => {
      cancelled = true
      clearTimeout(resetTimer.current)
    }
  }, [id, source])

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 1800)
    } catch (error) {
      console.error('Failed to copy the Mermaid diagram source.', error)
    }
  }

  return (
    <div className="my-5 min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#111214]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-neutral-300">
          <Icon name="code" size={14} className="shrink-0 text-neutral-500" />
          <span>{failed ? 'Diagram source' : 'Architecture diagram'}</span>
        </span>
        <button
          type="button"
          onClick={copySource}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-white/[0.07] hover:text-white"
          aria-label={copied ? 'Diagram source copied' : 'Copy diagram source'}
          title={copied ? 'Copied' : 'Copy diagram source'}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} className={copied ? 'text-emerald-300' : ''} />
          {copied && <span>Copied</span>}
        </button>
      </div>
      {svg ? (
        <div className="overflow-x-auto p-4 sm:p-6">
          <div className="mx-auto w-fit min-w-full [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      ) : failed ? (
        <pre className="overflow-x-auto p-4 text-xs leading-5 text-neutral-300">
          <code>{source}</code>
        </pre>
      ) : (
        <p role="status" className="px-4 py-6 text-center text-xs text-neutral-500">Preparing diagram…</p>
      )}
    </div>
  )
}

function CodeBlock({ children }) {
  const [copyState, setCopyState] = useState('Copy')
  const resetTimer = useRef(null)
  const codeElement = Array.isArray(children) ? children.find((child) => child?.type === 'code') : children
  const code = plainText(codeElement?.props?.children ?? children).replace(/\n$/, '')
  const language = /language-([\w-]+)/.exec(codeElement?.props?.className || '')?.[1]
  const asciiFlow = parseAsciiFlow(code)

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopyState('Copied')
    } catch {
      setCopyState('Copy failed')
    }
    clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopyState('Copy'), 1800)
  }

  if (language === 'mermaid' || /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram)\b/m.test(code.trim())) {
    return <MermaidDiagram source={code} />
  }
  if (asciiFlow) return <ArchitectureFlow nodes={asciiFlow} />
  if (language === 'recommendations') {
    const data = parseRecommendations(code)
    if (data?.items.some((item) => item && typeof item.title === 'string')) {
      return <RecommendationList data={data} />
    }
  }

  return (
    <div className="my-5 min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#1b1c20]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] bg-white/[0.025] px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-neutral-300">
          <Icon name="code" size={14} className="shrink-0 text-neutral-500" />
          <span className="truncate">{language || 'Code'}</span>
        </span>
        <button
          type="button"
          onClick={copyCode}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-white/[0.07] hover:text-white"
          aria-label={copyState === 'Copy' ? 'Copy code' : copyState}
          title={copyState === 'Copy' ? 'Copy code' : copyState}
        >
          <Icon name={copyState === 'Copied' ? 'check' : 'copy'} size={14} className={copyState === 'Copied' ? 'text-emerald-300' : ''} />
          {copyState !== 'Copy' && <span>{copyState}</span>}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto px-4 py-4 text-[13px] leading-6">
        {children}
      </pre>
    </div>
  )
}

const components = {
  h1: ({ children }) => <h1 className="mt-8 mb-3 text-xl font-semibold tracking-tight text-white first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-8 mb-3 text-lg font-semibold tracking-tight text-white first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-6 mb-2 text-base font-semibold text-white first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-5 mb-2 text-[15px] font-semibold text-white first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-3 break-words leading-7 text-neutral-200 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6 leading-7 text-neutral-200 [&_ul]:my-1.5 [&_ol]:my-1.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6 leading-7 text-neutral-200 [&_ul]:my-1.5 [&_ol]:my-1.5">{children}</ol>,
  li: ({ children }) => <li className="ps-1 marker:text-neutral-500 [&>p]:my-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic text-neutral-200">{children}</em>,
  code: ({ className, children, ...props }) => (
    <code
      className={`${className || ''} rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[0.88em] text-indigo-200`}
      {...props}
    >
      {children}
    </code>
  ),
  pre: CodeBlock,
  blockquote: ({ children }) => (
    <blockquote className="my-5 border-l-2 border-indigo-400/50 pl-4 text-neutral-400 [&>p]:my-2">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-7 border-white/10" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-indigo-300 underline decoration-indigo-300/40 underline-offset-4 hover:text-indigo-200">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-5 max-w-full overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full min-w-max border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/[0.04] text-neutral-100">{children}</thead>,
  th: ({ children }) => <th className="border-b border-white/10 px-3 py-2 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-white/[0.06] px-3 py-2 align-top text-neutral-200">{children}</td>,
  input: ({ checked, ...props }) => (
    <input type="checkbox" checked={checked} readOnly className="mr-2 accent-indigo-400" {...props} />
  ),
}

function Markdown({ text }) {
  const content = String(text || '')
  const statusReport = parseStatusMarkdown(content)
  const recommendations = parseRecommendationMarkdown(content)
  const markdown = (value, key) => (
    <ReactMarkdown key={key} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
      {value}
    </ReactMarkdown>
  )

  return (
    <div className="markdown-content min-w-0 max-w-full text-[15px] leading-7">
      {statusReport ? (
        <StatusReport data={statusReport} />
      ) : recommendations ? (
        <Fragment>
          {recommendations.before && markdown(recommendations.before, 'before')}
          <RecommendationList data={recommendations.data} />
          {recommendations.after && markdown(recommendations.after, 'after')}
        </Fragment>
      ) : markdown(content, 'answer')}
    </div>
  )
}

export default Markdown
