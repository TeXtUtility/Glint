import 'katex/dist/katex.min.css'
import { memo, useEffect, useRef, useState, type HTMLAttributes } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeMath, scrub } from '../../shared/markdown'
import { glint, isMac } from './glint'
import { Icon } from './icons'

// No raw HTML is rendered (react-markdown's default), so model output can't inject markup.
// Each render re-parses the whole reply (see streamEvery); an unclosed fence just renders as an open code block.

/**
 * Milliseconds a streaming reply waits between renders: each one re-parses all of it (~4 ms per 1,000 characters), so
 * a longer reply updates less often. Every frame while short; 4 times a second from about 6,000 characters.
 */
export const streamEvery = (chars: number) => Math.min(250, chars / 25)

/** Blocks of these languages get Run: shell commands. */
const SHELL = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'terminal', 'shell-session', 'shellsession', ...(isMac ? [] : ['powershell', 'pwsh', 'ps1', 'ps', 'cmd', 'bat'])])

/** Copy with a check that says Copied for a moment. `text` is read on click, from what's on screen. */
function CopyButton({ text, tip }: { text: () => string; tip: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    glint.send('app:copy', text())
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button className={`code-copy ${copied ? 'done' : ''}`} data-tip={tip} onClick={copy}>
      <span key={copied ? 'done' : 'copy'} className="swap-fade"><Icon name={copied ? 'check' : 'copy'} size={14} /></span>{copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/**
 * A code block with its language and a Copy button that copies exactly the code, ready to paste. Shell blocks also
 * get Run, which opens the user's terminal with the commands behind a y/N prompt (main/run.ts).
 */
function CodeBlock({ lang, ...p }: HTMLAttributes<HTMLPreElement> & { lang?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const [ran, setRan] = useState<{ ok: boolean; text: string } | null>(null)
  const runIt = () =>
    void glint.invoke<string>('run:commands', ref.current?.textContent ?? '').then(
      (app) => setRan({ ok: true, text: `Opened in ${app}` }),
      (err: Error) => setRan({ ok: false, text: err.message }),
    ).finally(() => setTimeout(() => setRan(null), 2500))
  // The highlighter only wraps text in spans, so this is the code as written. The parser ends every block with a
  // newline, which pasted into a terminal would run the command, so it's dropped.
  const code = () => (ref.current?.textContent ?? '').replace(/\n$/, '')
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? 'code'}</span>
        <span className="grow" />
        {lang && SHELL.has(lang) && (
          <button className={`code-copy code-run ${ran ? (ran.ok ? 'done' : 'failed') : ''}`} onClick={runIt}
            data-tip={ran && !ran.ok ? ran.text : 'Open these commands in your terminal. It asks y/N before running anything'}>
            <span key={ran ? 'ran' : 'run'} className="swap-fade"><Icon name={ran?.ok ? 'check' : 'terminal'} size={14} /></span>{ran?.ok ? ran.text : 'Run'}
          </button>
        )}
        <CopyButton text={code} tip="Copy this code exactly, ready to paste" />
      </div>
      <pre ref={ref} {...p} />
    </div>
  )
}

/** Quoted text in a reply is usually text to use (a rewritten email, a line to say), so it gets its own Copy. */
function QuoteBlock(p: HTMLAttributes<HTMLQuoteElement>) {
  const ref = useRef<HTMLQuoteElement>(null)
  return (
    <div className="quote-block">
      <blockquote ref={ref} {...p} />
      <CopyButton text={() => ref.current?.innerText.trim() ?? ''} tip="Copy this text as plain text" />
    </div>
  )
}

// Defined once: a component made inside Markdown would be a new component type on every chunk, and React would
// remount everything it renders (each code block, and its fade-in with it) as the reply streams.
const COMPONENTS: Components = {
  // A link's text can say anything and one click opens it outside Glint, so where it goes shows after it (styles.css).
  a: ({ node, ...p }) => {
    const host = /^https?:/i.test(p.href ?? '') ? URL.parse(p.href!)?.hostname.replace(/^www\./, '') : undefined
    return <a {...p} data-host={host && !textOf(node as HNode | undefined).toLowerCase().includes(host) ? host : undefined} target="_blank" rel="noreferrer" />
  },
  // A new key per chunk remounts the newest words' span, so each chunk fades in.
  span: ({ node: _, ...p }) => <span key={(p as Record<string, unknown>)['data-at'] as string | undefined} {...p} />,
  blockquote: ({ node: _, ...p }) => <QuoteBlock {...p} />,
  pre: ({ node, ...p }) => {
    const code = node?.children[0]
    const classes = code?.type === 'element' ? code.properties.className : undefined
    const lang = Array.isArray(classes) ? classes.map(String).find((c) => c.startsWith('language-'))?.slice(9) : undefined
    return <CodeBlock lang={lang} {...p} />
  },
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const md = normalizeMath(scrub(text))
  const prev = useRef('')
  useEffect(() => void (prev.current = md))
  const fresh = streaming && md.startsWith(prev.current) ? md.length - prev.current.length : 0
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // Untagged code gets its language guessed only once the reply is done: guessing on every chunk of half-written
        // code can flip languages, and the colours with them. Tagged code is coloured as it streams.
        rehypePlugins={[[rehypeKatex, { throwOnError: false }], [rehypeHighlight, { detect: !streaming }], ...(fresh ? [rehypeFresh(fresh, md.length)] : [])]}
        components={COMPONENTS}
      >
        {md}
      </ReactMarkdown>
    </div>
  )
})

type HNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HNode[] }

const textOf = (n?: HNode): string => n?.value ?? n?.children?.map(textOf).join('') ?? ''

/**
 * Wraps the answer's last `n` characters (the newest chunk while it streams) in a span that fades in, over the wait
 * for the next chunk: a long reply's bigger chunks ease in rather than pop.
 */
function rehypeFresh(n: number, at: number) {
  const last = (node: HNode): [HNode, HNode] | null => {
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) {
      const c = node.children![i]
      if (c.type === 'text' && c.value?.trim()) return [node, c]
      const hit = c.children && last(c)
      if (hit) return hit
    }
    return null
  }
  return () => (tree: HNode) => {
    const hit = last(tree)
    if (!hit) return
    const [parent, text] = hit
    const cut = Math.max(0, text.value!.length - n)
    const span: HNode = { type: 'element', tagName: 'span', properties: { className: ['fresh'], dataAt: String(at), style: `animation-duration: ${Math.max(80, streamEvery(at))}ms` }, children: [{ type: 'text', value: text.value!.slice(cut) }] }
    parent.children!.splice(parent.children!.indexOf(text), 1, ...(cut ? [{ type: 'text', value: text.value!.slice(0, cut) }] : []), span)
  }
}

