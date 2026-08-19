/**
 * Session-mode picker copy. Product copy is Chinese; the English counterpart
 * mirrors it for the shipped bilingual surface.
 */

/** Chinese product strings. */
export const zh = {
  'mode.chip': '模式',
  'mode.native': 'DSH 智能体',
  'mode.seatHint': '选择谁驱动下一个会话',
  'mode.busy': '读取模式中…',
  'mode.model': '模型',
  'mode.modelDefault': '默认模型',
  'mode.modelUnavailable': '模型目录不可用',
  'mode.create': '创建会话',
} as const

/** English product strings. */
export const en = {
  'mode.chip': 'Mode',
  'mode.native': 'DSH Agent',
  'mode.seatHint': 'Choose who drives the next session',
  'mode.busy': 'Loading modes…',
  'mode.model': 'Model',
  'mode.modelDefault': 'Default model',
  'mode.modelUnavailable': 'Model directory unavailable',
  'mode.create': 'Create session',
} as const

/** The picker namespace's copy keys, shared by zh and en. */
export type ModeSeatKey = keyof typeof zh
