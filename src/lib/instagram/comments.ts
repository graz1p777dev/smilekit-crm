// Ответ бота на комментарии под постами Instagram.
//
// Два действия на один комментарий:
//   1) публичный ответ веткой под комментарием (POST /{ig-comment-id}/replies) —
//      коротко и по делу, чтобы под постом не висел вопрос без ответа;
//   2) приватное сообщение автору в директ («private reply», recipient.comment_id) —
//      Meta разрешает его ровно один раз на комментарий, повтор вернёт ошибку.
//      Приватный ответ — не обязательный: если Meta откажет (прав нет, окно
//      прошло), публичный ответ всё равно остаётся, и это не считается сбоем.
//
// Оба требуют разрешения instagram_business_manage_comments — см.
// INSTAGRAM_SCOPES в oauth.ts. Аккаунт, подключённый до его появления, этих
// прав не имеет: нужно заново пройти «Подключить» в CRM.
//
// ВАЖНО: только серверный код — здесь service-role клиент Supabase.

import { getInstagramBotSettings } from '@/lib/instagram/config'
import { InstagramApiError } from '@/lib/instagram/errors'
import { replyToInstagramComment, sendInstagramPrivateReply } from '@/lib/instagram/messaging'
import { commentReplyFor, COMMENT_PRIVATE_REPLY } from '@/lib/instagram/texts'
import { claimComment, markCommentReplied, type ParsedIncomingComment } from '@/lib/instagram/webhook'

/**
 * Обработка одного комментария. Ничего не бросает наружу — вебхук обязан
 * ответить Meta 200 в любом случае.
 */
export async function handleInstagramComment(comment: ParsedIncomingComment): Promise<void> {
  // Дедуп по id комментария: повторная доставка вебхука не должна давать
  // второй публичный ответ (и уж тем более второй private reply — на него
  // Meta ответит ошибкой).
  if (!(await claimComment(comment))) return

  const settings = await getInstagramBotSettings()
  // Выключено — комментарий всё равно сохранён (status='received'), владелец
  // видит его в CRM и отвечает сам.
  if (!settings.commentsEnabled) return
  if (!comment.text.trim()) return

  const replyText = commentReplyFor(comment.text)
  try {
    await replyToInstagramComment(comment.commentId, replyText)
  } catch (error) {
    const message = error instanceof InstagramApiError ? error.message : String(error)
    await markCommentReplied(comment.commentId, { status: 'failed', error: message })
    return
  }

  let privateReplySent = false
  try {
    await sendInstagramPrivateReply(comment.commentId, COMMENT_PRIVATE_REPLY)
    privateReplySent = true
  } catch (error) {
    // Не ошибка обработки: публичный ответ уже ушёл. Просто фиксируем, что
    // в директ написать не дали (нет прав / комментарий слишком старый).
    console.error('instagram comments: private reply skipped', error)
  }

  await markCommentReplied(comment.commentId, { replyText, privateReplySent, status: 'replied' })
}
