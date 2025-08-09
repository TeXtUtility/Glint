import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeEntities, htmlText, officeXmlText, rtfText } from './doctext.ts'

test('htmlText: blocks become lines, scripts and styles go, entities decode', () => {
  const html = '<html><head><title>T</title><style>p{}</style></head><body><h1>Plan</h1>\n<p>One   &amp;\n two</p><ul><li>a</li><li>b&nbsp;c</li></ul><script>x()</script><table><tr><td>1</td><td>2</td></tr></table></body></html>'
  assert.equal(htmlText(html).trim(), 'Plan\nOne & two\na\nb c\n1\t2')
  assert.equal(decodeEntities('&#8212;&#x41;&unknown;'), '—A&unknown;')
})

test('officeXmlText: paragraphs, tabs and breaks; field codes and deleted text left out', () => {
  const docx = '<w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">world </w:t></w:r></w:p>'
    + '<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:delText>gone</w:delText><w:t>Line</w:t><w:br/><w:t>two</w:t></w:r></w:p></w:body>'
  assert.equal(officeXmlText(docx), 'Hello\tworld \nLine\ntwo\n')
  const odt = '<text:h>Title</text:h><text:p>a<text:s text:c="3"/>b<text:tab/>c</text:p>'
  assert.equal(officeXmlText(odt), 'Title\na   b\tc\n')
})

test('rtfText: text and paragraphs, with fonts, colours and ignorable groups left out', () => {
  const rtf = "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Riched20;}\\f0 Caf\\'e9 \\b bold\\b0\\par Next\\tab line \\u8212?done\\par}"
  assert.equal(rtfText(rtf), 'Café bold\nNext\tline —done\n')
})
