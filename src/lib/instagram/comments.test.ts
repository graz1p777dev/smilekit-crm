// Ответ бота на комментарии — на поддельных ответах Graph API.

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/instagram/config', () => ({ getInstagramBotSettings: vi.fn() }))
vi.mock('@/lib/instagram/messaging', () => ({
  replyToInstagramComment: vi.fn(),
  sendInstagramPrivateReply: vi.fn(),
}))
vi.mock('@/lib/instagram/webhook', () => ({
  claimComment: vi.fn(),
  markCommentReplied: vi.fn(),
}))

import { getInstagramBotSettings } from '@/lib/instagram/config'
import { replyToInstagramComment, sendInstagramPrivateReply } from '@/lib/instagram/messaging'
import { claimComment, markCommentReplied, type ParsedIncomingComment } from '@/lib/instagram/webhook'
import { InstagramApiError } from '@/lib/instagram/errors'
import { handleInstagramComment } from '@/lib/instagram/comments'
import {
  commentReplyFor,
  COMMENT_REPLY_PRICE,
  COMMENT_REPLY_DELIVERY,
  COMMENT_REPLY_DEFAULT,
  INSTAGRAM_GREETING,
  SENT_TO_DM_REPLY,
} from '@/lib/instagram/texts'

const comment: ParsedIncomingComment = {
  commentId: 'c1',
  mediaId: 'media1',
  parentCommentId: null,
  authorIgsid: 'u1',
  authorUsername: 'client',
  text: 'Сколько стоит?',
  accountId: 'acct1',
  commentedAtMs: Date.now(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(claimComment).mockResolvedValue(true)
  vi.mocked(getInstagramBotSettings).mockResolvedValue({ dmEnabled: false, commentsEnabled: true })
  vi.mocked(replyToInstagramComment).mockResolvedValue('reply1')
  vi.mocked(sendInstagramPrivateReply).mockResolvedValue('dm1')
})

describe('commentReplyFor — короткий ответ по теме', () => {
  it('вопрос про цену', () => {
    expect(commentReplyFor('а сколько стоит?')).toBe(COMMENT_REPLY_PRICE)
    expect(commentReplyFor('Баасы канча?')).toBe(COMMENT_REPLY_PRICE)
  })
  it('вопрос про доставку', () => {
    expect(commentReplyFor('В Ош доставка есть?')).toBe(COMMENT_REPLY_DELIVERY)
  })
  it('всё остальное — общий ответ', () => {
    expect(commentReplyFor('Класс!')).toBe(COMMENT_REPLY_DEFAULT)
  })
})

describe('handleInstagramComment', () => {
  it('отвечает публично «отправили в директ» и реально пишет туда приветствие', async () => {
    await handleInstagramComment(comment)
    expect(sendInstagramPrivateReply).toHaveBeenCalledWith('c1', INSTAGRAM_GREETING)
    expect(replyToInstagramComment).toHaveBeenCalledWith('c1', SENT_TO_DM_REPLY)
    expect(markCommentReplied).toHaveBeenCalledWith('c1', expect.objectContaining({ status: 'replied', privateReplySent: true }))
  })

  it('повтор вебхука по тому же id — второго ответа нет', async () => {
    vi.mocked(claimComment).mockResolvedValue(false)
    await handleInstagramComment(comment)
    expect(replyToInstagramComment).not.toHaveBeenCalled()
    expect(sendInstagramPrivateReply).not.toHaveBeenCalled()
  })

  it('переключатель комментариев выключен — комментарий сохранён, ответа нет', async () => {
    vi.mocked(getInstagramBotSettings).mockResolvedValue({ dmEnabled: true, commentsEnabled: false })
    await handleInstagramComment(comment)
    expect(claimComment).toHaveBeenCalled()
    expect(replyToInstagramComment).not.toHaveBeenCalled()
  })

  it('Meta не дала написать в директ — публичный ответ остаётся по теме комментария', async () => {
    vi.mocked(sendInstagramPrivateReply).mockRejectedValue(
      new InstagramApiError('INSTAGRAM_PERMISSION_DENIED', 'нет прав')
    )
    await handleInstagramComment(comment)
    expect(replyToInstagramComment).toHaveBeenCalledWith('c1', COMMENT_REPLY_PRICE)
    expect(markCommentReplied).toHaveBeenCalledWith('c1', expect.objectContaining({ status: 'replied', privateReplySent: false }))
  })

  it('Instagram не подключён (публичный ответ упал) — не падаем, помечаем неудачу', async () => {
    vi.mocked(replyToInstagramComment).mockRejectedValue(
      new InstagramApiError('INSTAGRAM_NOT_CONNECTED', 'Instagram не подключён')
    )
    await expect(handleInstagramComment(comment)).resolves.toBeUndefined()
    expect(sendInstagramPrivateReply).toHaveBeenCalledWith('c1', INSTAGRAM_GREETING)
    expect(markCommentReplied).toHaveBeenCalledWith('c1', expect.objectContaining({ status: 'failed', privateReplySent: true }))
  })

  it('пустой комментарий (только фото/эмодзи-реакция без текста) — не отвечаем', async () => {
    await handleInstagramComment({ ...comment, text: '   ' })
    expect(replyToInstagramComment).not.toHaveBeenCalled()
  })
})
