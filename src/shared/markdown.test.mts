import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyText, normalizeMath, plainLine, scrub, splitSources, texToText, toPlain, wholeSentences } from './markdown.ts'

test('normalizeMath converts LaTeX delimiters outside code only', () => {
  assert.equal(normalizeMath('so \\(x^2\\) and \\[\\frac{a}{b}\\]'), 'so $x^2$ and $$\\frac{a}{b}$$')
  assert.equal(normalizeMath('`\\(x\\)` stays'), '`\\(x\\)` stays')
  assert.equal(normalizeMath('```\n\\[x\\]\n```\n\\(y\\)'), '```\n\\[x\\]\n```\n$y$')
  assert.equal(normalizeMath('streaming ```py\nprint("\\(x\\)")'), 'streaming ```py\nprint("\\(x\\)")') // unclosed fence
  assert.equal(normalizeMath('~~~bash\necho $HOME\n~~~'), '~~~bash\necho $HOME\n~~~')
})

test('normalizeMath keeps math dollars and escapes money', () => {
  assert.equal(normalizeMath('costs $5 to $10'), 'costs \\$5 to \\$10')
  assert.equal(normalizeMath('$x^2$ and $y$'), '$x^2$ and $y$')
  assert.equal(normalizeMath('$$E = mc^2$$ for $5'), '$$E = mc^2$$ for \\$5')
  assert.equal(normalizeMath('already \\$3'), 'already \\$3')
  assert.equal(normalizeMath('`$5` in code'), '`$5` in code')
})

test('copyText: whole reply, or the first code block without its fences', () => {
  const reply = 'Fix:\n```python\nprint(1)\nprint(2)\n```\nThen run it.\n```sh\npython x.py\n```'
  assert.equal(copyText(reply, 'code'), 'print(1)\nprint(2)')
  assert.equal(copyText('  just text  ', 'code'), 'just text')
  assert.equal(copyText(reply, 'reply'), toPlain(reply))
  // Inside a list item the fence is indented; the copied code isn't, and its own indentation stays.
  assert.equal(copyText('1. Run:\n   ```python\n   def f():\n       return 1\n   ```\n2. Done', 'code'), 'def f():\n    return 1')
  assert.equal(copyText('~~~sh\nnpm test\n~~~', 'code'), 'npm test')
})

test('plainLine: first line of text, without markdown', () => {
  assert.equal(plainLine('**Say:** we ship Friday.\n\nMore detail'), 'Say: we ship Friday.')
  assert.equal(plainLine('```js\nx()\n```\n- Use [the docs](http://x) first'), 'Use the docs first')
  assert.equal(plainLine(''), '')
})

test('toPlain: formatting marks go, maths reads as normal notation, code and money stay exact', () => {
  const md = '## Answer\n\n**The derivative** of $x^3$ is $3x^2$, and *that* is it.\n\n- Step one: `d/dx`\n- Costs $5 to $10\n\n$$\\frac{a}{b} \\times 2$$\n\n| Name | Value |\n|---|---:|\n| x | 2 |\n\n```python\nprint("**not bold**")\n```\n\nSee [docs](https://x.com) and \\(\\alpha\\).\n\n> _quoted_ snake_case_name 2*3*4'
  assert.equal(toPlain(md), 'Answer\n\nThe derivative of x³ is 3x², and that is it.\n\n• Step one: d/dx\n• Costs $5 to $10\n\na/b × 2\n\nName\tValue\nx\t2\n\nprint("**not bold**")\n\nSee docs (https://x.com) and α.\n\nquoted snake_case_name 2*3*4')
})

test('texToText: common LaTeX in answers', () => {
  const cases: [string, string][] = [
    ['\\frac{1}{2}', '1/2'], ['\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', '(-b ± √(b²-4ac))/(2a)'], ['\\frac{dy}{dx}', 'dy/dx'], ['\\sqrt{x+1}', '√(x+1)'], ['\\sqrt[3]{8}', '∛8'], ['a_{n-1}', 'aₙ₋₁'], ['90^\\circ', '90°'],
    ['e^{i\\pi}', 'e^(iπ)'], ['\\left( \\frac{a}{b} \\right)^2', '(a/b)²'], ['\\text{if } x \\le 3', 'if x ≤ 3'],
    ['-RT\\ln K', '-RT ln K'], ['\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', 'Σᵢ₌₁ⁿ i = (n(n+1))/2'],
    ['\\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}', 'x, x ≥ 0\n-x, x < 0'],
    ['\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}', '(1 2; 3 4)'], ['100\\%', '100%'],
  ]
  for (const [tex, text] of cases) assert.equal(texToText(tex), text, tex)
})

test('scrub: leaked citation markers go, whole or mid-stream, with or without their private characters', () => {
  assert.equal(scrub('aciteturn0file3 b'), 'a b')
  assert.equal(scrub('streaming citetur'), 'streaming ')
  assert.equal(scrub('in 1911. fileciteturn0file3turn0file1 Neither'), 'in 1911.  Neither')
  assert.equal(toPlain('in 1911. fileciteturn0file3turn0file1 Neither'), 'in 1911. Neither')
  assert.equal(scrub('I cite my sources.'), 'I cite my sources.')
})

test('padded \\( x \\) is still math; a code-only reply still has a Glance line', () => {
  assert.equal(normalizeMath('area \\( \\pi r^2 \\)'), 'area $\\pi r^2$')
  assert.equal(plainLine('```bash\nls -la\n```'), 'ls -la')
  assert.equal(plainLine('Run this:\n```bash\nls\n```'), 'Run this:')
})

test('wholeSentences keeps finished sentences and lines only', () => {
  assert.equal(wholeSentences('Hello world. This is'), 'Hello world.')
  assert.equal(wholeSentences('One. Two! Three? Fo'), 'One. Two! Three?')
  assert.equal(wholeSentences('Pi is 3.14 and'), '')
  assert.equal(wholeSentences('- first\n- sec'), '- first\n')
  assert.equal(wholeSentences('**Done.** Next'), '**Done.**')
  assert.equal(wholeSentences('He said "yes." Then'), 'He said "yes."')
  assert.equal(wholeSentences('Nothing finished yet'), '')
})

test('splitSources: the closing Sources line becomes links; anything else stays', () => {
  const r = splitSources('It ships in May.\n\nSources: [The Verge](https://theverge.com/a), [apple.com](https://www.apple.com/b)')
  assert.equal(r.body, 'It ships in May.')
  assert.deepEqual(r.sources, [{ title: 'The Verge', url: 'https://theverge.com/a' }, { title: 'apple.com', url: 'https://www.apple.com/b' }])
  assert.deepEqual(splitSources('**Sources:** [x](https://x.com)\n').sources.length, 0) // no answer before it: first line, left alone
  assert.equal(splitSources('Answer.\n**Sources:** [x](https://x.com)').body, 'Answer.')
  assert.equal(splitSources('Sources: below.\nMore text.').sources.length, 0)
  assert.equal(splitSources('A.\nSources: [js](javascript:alert(1))').sources.length, 0) // only web links
})
