import type { Locale } from './config';

/**
 * `<title>` and the description, per interface language.
 *
 * Kept out of the dictionary because a search result is not part of the rendered
 * interface: these strings are read by crawlers and by the browser tab, and they
 * must follow the cookie even before React has hydrated.
 */
export const SITE_META: Record<Locale, { title: string; description: string }> = {
  ru: {
    title: 'AnonLink — анонимный чат',
    description:
      'Анонимный чат один на один: случайный собеседник или чат по User ID. Без регистрации, почты и телефона.',
  },
  en: {
    title: 'AnonLink — anonymous chat',
    description:
      'One-to-one anonymous chat: a random partner or a chat by User ID. No sign-up, e-mail or phone number.',
  },
  zh: {
    title: 'AnonLink — 匿名聊天',
    description: '一对一匿名聊天：随机匹配或通过 User ID 聊天。无需注册、邮箱或电话号码。',
  },
};
