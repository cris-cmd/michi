// Test-side re-exports so the deterministic suite can assert the i18n layer.
export { MESSAGES, SPEECH_LANG, STT_LOCALE } from '../src/i18n';
export { GREETINGS as GREETINGS_CHECK } from '../src/agent/prompt';
