import type { EditBufferRenderable } from "@opentui/core"

const words = new Intl.Segmenter(undefined, { granularity: "word" })
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Include leading whitespace/punctuation and one Unicode word, or one symbol. */
export function wordPrefix(text: string) {
  for (const item of words.segment(text)) {
    if (item.isWordLike) return text.slice(0, item.index + item.segment.length)
    if (item.segment.trim()) {
      const first = graphemes.segment(item.segment)[Symbol.iterator]().next().value
      if (first) return text.slice(0, item.index + first.segment.length)
    }
  }
  return text
}

export function atEnd(editor: EditBufferRenderable) {
  return (
    editor.logicalCursor.row === editor.editBuffer.getLineCount() - 1 &&
    editor.logicalCursor.col === editor.editBuffer.getEOL().col
  )
}

export function appendSuffix(editor: EditBufferRenderable, input: string, suffix: string) {
  if (editor.isDestroyed || editor.plainText !== input || editor.hasSelection()) return false
  const cursor = editor.cursorOffset
  const end = atEnd(editor)
  editor.gotoBufferEnd()
  editor.insertText(suffix)
  if (!end) editor.cursorOffset = cursor
  return true
}
