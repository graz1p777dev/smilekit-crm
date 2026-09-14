/**
 * Голосовые для рассылок.
 *
 * Файлы лежат в `public/voice/` и раздаются самим доменом CRM. Green API
 * отправляет голосовое ПО ССЫЛКЕ (sendGreenApiVoice → urlFile), поэтому
 * отдельный бакет в Storage не нужен: публичный URL у нас уже есть.
 *
 * Расширение файла — `.ogg`, а не `.opus`: WhatsApp ждёт ogg-контейнер, и
 * сервер отдаёт для него правильный audio/ogg. Внутри тот же Opus.
 *
 * Чтобы добавить новое голосовое: положить файл в `public/voice/` и
 * дописать сюда строку.
 */
export interface VoiceMessage {
  /** Стабильный id — он уходит в базу и в ссылку. */
  id: string
  /** Как называется рассылка в интерфейсе. */
  label: string
  /** Имя файла в public/voice/. */
  file: string
}

export const VOICE_MESSAGES: VoiceMessage[] = [
  {
    id: 'dve-upakovki-skidka-10',
    label: '2 упаковки — скидка 10%',
    file: 'rassylka-2-upakovki-skidka-10.ogg',
  },
]

export function voiceById(id: string | null | undefined): VoiceMessage | null {
  if (!id) return null
  return VOICE_MESSAGES.find((voice) => voice.id === id) ?? null
}

/** Путь для плеера в браузере. */
export function voiceSrc(voice: VoiceMessage): string {
  return `/voice/${voice.file}`
}
