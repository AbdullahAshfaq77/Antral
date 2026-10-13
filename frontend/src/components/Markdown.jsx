import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import 'highlight.js/styles/github-dark.css'

function plainText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (node && typeof node === 'object' && 'props' in node) return plainText(node.props.children)
  return ''
}

function CodeBlock({ children }) {
  const [copyState, setCopyState] = useState('Copy')
  const resetTimer = useRef(null)
  const codeElement = Array.isArray(children) ? children.find((child) => child?.type === 'code') : children
  const code = plainText(codeElement?.props?.children ?? children).replace(/\n$/, '')
  const language = /language-([\w-]+)/.exec(codeElement?.props?.className || '')?.[1]

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

  return (
    <div className="my-5 min-w-0 overflow-hidden rounded-xl border border-white/10 bg-[#101114]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-2">
        <span className="min-w-0 truncate text-[11px] font-medium text-neutral-500">
          {language || 'Code'}
        </span>
        <button
          type="button"
          onClick={copyCode}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-400 transition hover:bg-white/[0.07] hover:text-white"
          aria-label="Copy code"
        >
          {copyState}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto px-4 py-3 text-[13px] leading-6">
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
  return (
    <div className="markdown-content min-w-0 max-w-full text-[15px] leading-7">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {String(text || '')}
      </ReactMarkdown>
    </div>
  )
}

export default Markdown
