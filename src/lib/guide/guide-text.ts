// Текст публичной инструкции (public/instrukciya.html) без разметки — по
// нему отвечает помощник на странице инструкции. Читается один раз на
// процесс: файл меняется только с деплоем.

import { readFile } from 'fs/promises'
import path from 'path'

let cached: string | null = null

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|li|h[1-6]|tr|div|section|summary|details)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

export async function guideText(): Promise<string> {
  if (cached) return cached
  const html = await readFile(path.join(process.cwd(), 'public', 'instrukciya.html'), 'utf8')
  cached = htmlToText(html)
  return cached
}
