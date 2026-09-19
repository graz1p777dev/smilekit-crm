import { expect, it } from 'vitest'
import { htmlToText } from './guide-text'

it('убирает разметку, скрипты и сущности', () => {
  const text = htmlToText('<style>a{}</style><h2>Рассылки</h2><p>Нажмите &laquo;Запланировать&raquo;&nbsp;— и всё</p><script>x()</script>')
  expect(text).toContain('Рассылки')
  expect(text).toContain('Нажмите «Запланировать» — и всё')
  expect(text).not.toContain('x()')
  expect(text).not.toContain('<')
})
